/**
 * evo-sdk singleton service — the one Platform connection for the whole app.
 *
 * S0.3 (DECIDED): the ONLY WASM-viable connection is `EvoSDK.testnetTrusted()` /
 * `mainnetTrusted()` (or the trusted devnet equivalent) with `*WithProof` reads. `EvoSDK.testnet()` and `{proofs:false}`
 * both crash WASM, so forge-web is trust-minimized (quorum keys from a known endpoint),
 * never "fully trustless". Proofs are always on (~0% per-query overhead).
 *
 * Pattern ported from yappr's `evo-sdk-service`: idempotent initialize, in-flight promise
 * dedupe, contract preload before marking ready, and reconnect. One process-wide instance.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS, type Network } from '../constants'
import { installDapiFetchGate } from './budget'
import { loadContractSnapshots } from './contract-seed'
import { setPlatformVersion } from './query'

export interface EvoSdkConfig {
  readonly network: Network
  /** Contract ids to preload (DPNS + the forge-v2 contracts). */
  readonly contractIds: readonly string[]
  /** Per-request timeout (ms). */
  readonly timeoutMs?: number
}

interface ContractsFacadeLike {
  fetch: (contractId: string) => Promise<unknown>
  addKnown: (contract: unknown) => Promise<boolean>
}
interface SdkContractsLike {
  contracts: ContractsFacadeLike
}

class EvoSdkService {
  private sdk: EvoSDK | null = null
  private initPromise: Promise<void> | null = null
  private config: EvoSdkConfig | null = null
  private ready = false
  private trusted = false
  /** Contract ids seeded from the bundled snapshots: in the SDK's cache without a fetch. */
  private readonly seeded = new Set<string>()

  /** Whether the SDK is connected and its contracts are preloaded. */
  get isReady(): boolean {
    return this.ready
  }

  /**
   * Whether the live connection proof-checks its reads. A trusted connect prefetches the
   * quorum keys and verifies every plain `.query()` against them (design-freeze-2 #5); any
   * other connection would return node answers unchecked. The trust panel derives its
   * "proofs" state from this rather than assuming it.
   */
  get isTrusted(): boolean {
    return this.ready && this.trusted
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
    // Every DAPI request this page makes goes through the shared request budget (`budget.ts`),
    // which waits out a node's rate limit and retries on the same node. `banFailedAddress: false`
    // keeps any failure that still reaches the SDK from banning a node: the SDK then only moves
    // the next request to another node (rs-dapi-client `update_address_ban_status`), so a burst
    // of refusals can no longer leave it with "no available addresses" (D-102, D-902).
    installDapiFetchGate()
    const options = { settings: { timeoutMs: config.timeoutMs ?? 8000, banFailedAddress: false } }
    // Dynamic import so the ~9.4 MB evo-sdk WASM chunk loads on first data need (post-paint),
    // never in the initial bundle — the whole app is a static-export SPA (yappr lazy-init pattern).
    const { EvoSDK } = await import('@dashevo/evo-sdk')
    if (config.network === 'devnet') {
      // A named devnet: trusted quorum keys from `quorums.<name>.networks.dash.org` (or the
      // deployment file's quorumBaseUrl); DAPI from the configured list, else discovered by
      // the trusted context.
      const devnet = NETWORKS.devnet
      if (devnet.devnetName === null) {
        throw new Error('devnet selected without NEXT_PUBLIC_DEVNET_NAME')
      }
      this.sdk = new EvoSDK({
        ...options,
        network: 'devnet',
        trusted: true,
        devnetName: devnet.devnetName,
        ...(devnet.quorumBaseUrl !== null ? { quorumUrl: devnet.quorumBaseUrl } : {}),
        ...(devnet.dapiAddresses.length > 0 ? { addresses: [...devnet.dapiAddresses] } : {}),
      })
    } else {
      this.sdk =
        config.network === 'mainnet'
          ? EvoSDK.mainnetTrusted(options)
          : EvoSDK.testnetTrusted(options)
    }
    await this.sdk.connect()
    // Both constructors above are the *Trusted variants — record it so the UI reports what
    // this connection does rather than what the app intends.
    this.trusted = true
    // Seed the bundled contract snapshots, then preload what is still missing, BEFORE marking
    // ready so getSdk() callers never see an unwarmed SDK.
    await this.seed(NETWORKS[config.network].key)
    await this.preload(config.contractIds)
    // evo-sdk 4.2 starts at a per-network floor (13 on testnet/mainnet, 14 on a devnet) and
    // learns the network's real version from the first proof-verified response. With seeded
    // contracts that response may be the page's first query, so this is the floor or better;
    // `queryDocuments` follows the SDK's version after every response.
    try {
      setPlatformVersion(this.sdk.version())
    } catch {
      // Keep the default version if the SDK cannot report one.
    }
    this.ready = true
  }

  /**
   * Add the deployment's contract snapshots (`contract-seed.ts`) to the SDK's contract cache,
   * so no page spends a `getDataContract` request on them. A snapshot that fails to decode is
   * skipped: {@link preload} then fetches that contract as before.
   */
  private async seed(deploymentKey: string): Promise<void> {
    if (!this.sdk) return
    const snapshots = await loadContractSnapshots(deploymentKey).catch(() => ({}))
    const entries = Object.entries(snapshots)
    if (entries.length === 0) return
    const { DataContract } = await import('@dashevo/evo-sdk')
    const contracts = (this.sdk as unknown as SdkContractsLike).contracts
    for (const [id, snapshot] of entries) {
      try {
        const contract = DataContract.fromBase64(snapshot.bytes, false, snapshot.platformVersion)
        if (await contracts.addKnown(contract)) this.seeded.add(id)
      } catch {
        // Fall back to fetching this one.
      }
    }
  }

  private async preload(contractIds: readonly string[]): Promise<void> {
    if (!this.sdk) return
    const contracts = (this.sdk as unknown as SdkContractsLike).contracts
    await Promise.all(
      contractIds.filter((id) => !this.seeded.has(id)).map((id) =>
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
    this.seeded.clear()
    this.ready = false
    this.trusted = false
    this.config = null
    this.initPromise = null
  }
}

/** The process-wide evo-sdk service singleton. */
export const evoSdkService = new EvoSdkService()

/**
 * The connected SDK for `network`, connecting first if needed (the DPNS and forge-v2
 * contracts preloaded). Flows that start before any page has connected (sign-in) use this.
 */
export async function ensureSdk(network: Network): Promise<EvoSDK> {
  const { dpnsContractId, v2 } = NETWORKS[network]
  const contractIds = [dpnsContractId, v2?.core, v2?.collab].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  )
  await evoSdkService.initialize({ network, contractIds, timeoutMs: 15000 })
  return evoSdkService.getSdk()
}
