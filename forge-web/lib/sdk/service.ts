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
import { followSdkVersion, setStaleContractHandler } from './query'

/** How often the seeded contracts are checked against the network (spec §3.4: once per hour). */
const SEED_CHECK_MS = 60 * 60 * 1000
const SEED_CHECK_KEY = 'forge.seededContractsChecked.v1'

/** When the seeded contracts of `deploymentKey` last matched the network, or 0. */
function lastSeedCheck(deploymentKey: string, versions: string): number {
  try {
    const saved = JSON.parse(localStorage.getItem(SEED_CHECK_KEY) ?? '{}') as Record<string, { at?: number; versions?: string }>
    const entry = saved[deploymentKey]
    return entry?.versions === versions && typeof entry.at === 'number' && entry.at <= Date.now() ? entry.at : 0
  } catch {
    return 0
  }
}

function recordSeedCheck(deploymentKey: string, versions: string): void {
  try {
    const saved = JSON.parse(localStorage.getItem(SEED_CHECK_KEY) ?? '{}') as Record<string, unknown>
    saved[deploymentKey] = { at: Date.now(), versions }
    localStorage.setItem(SEED_CHECK_KEY, JSON.stringify(saved))
  } catch {
    // No storage: the check simply runs on every load.
  }
}

export interface EvoSdkConfig {
  readonly network: Network
  /** Contract ids to preload (DPNS + the forge-v2 contracts). */
  readonly contractIds: readonly string[]
  /** Per-request timeout (ms). */
  readonly timeoutMs?: number
}

class EvoSdkService {
  private sdk: EvoSDK | null = null
  private initPromise: Promise<void> | null = null
  private config: EvoSdkConfig | null = null
  private ready = false
  private trusted = false
  /** Contracts seeded from the bundled snapshots (id → snapshot version), not fetched. */
  private seeded = new Map<string, number>()

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
    // Every DAPI request this page makes goes through the shared request budget (`budget.ts`).
    // `banFailedAddress: false`: a failed attempt only drops the node from the SDK's sticky
    // rotation and the next attempt goes to another node (rs-dapi-client
    // `update_address_ban_status`); nothing is banned, so a burst of refusals can no longer
    // leave the SDK with "no available addresses" (D-102, D-902). The trade-off: the SDK no
    // longer keeps a node that is really down out for minutes. The gate does that instead, for
    // `DOWN_MS`, from network errors, HTTP 5xx and gRPC `Unavailable`. It also turns off the
    // SDK's DPNS-registration owner failover, which this app does not use (it registers no names).
    installDapiFetchGate(NETWORKS[config.network].dapiAddresses)
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
    this.seeded = await this.seed(NETWORKS[config.network].key)
    await this.preload(config.contractIds.filter((id) => !this.seeded.has(id)))
    // evo-sdk 4.2 starts at a per-network floor (13 on testnet/mainnet, 14 on a devnet) and
    // learns the network's real version from the first proof-verified response. With seeded
    // contracts that response may be the page's first query, so this is the floor or better;
    // `queryDocuments` and the writes follow the SDK's version after every response.
    followSdkVersion(this.sdk)
    setStaleContractHandler((id) => this.refreshSeeded(id))
    this.ready = true
    // Off the critical path: are the seeded contracts still the network's current versions?
    void this.revalidateSeeded(NETWORKS[config.network].key)
  }

  /**
   * Add the deployment's contract snapshots (`contract-seed.ts`) to the SDK's contract cache,
   * so no page spends a `getDataContract` request on them. A snapshot that fails to decode is
   * skipped: {@link preload} then fetches that contract as before.
   */
  private async seed(deploymentKey: string): Promise<Map<string, number>> {
    const seeded = new Map<string, number>()
    const sdk = this.sdk
    if (!sdk) return seeded
    const snapshots = await loadContractSnapshots(deploymentKey).catch(() => ({}))
    const entries = Object.entries(snapshots)
    if (entries.length === 0) return seeded
    const { DataContract } = await import('@dashevo/evo-sdk')
    for (const [id, snapshot] of entries) {
      try {
        const contract = DataContract.fromBase64(snapshot.bytes, false, snapshot.platformVersion)
        if (await sdk.contracts.addKnown(contract)) seeded.set(id, snapshot.version)
      } catch {
        // Fall back to fetching this one.
      }
    }
    return seeded
  }

  /**
   * Compare the seeded contracts with the network's current versions (one request,
   * `getDataContractsLatestVersions`) and refetch any that moved on, e.g. forge-collab after a
   * contract update. The SDK also refetches on its own once a document carries a newer
   * `$contractVersion`; this catches the update before any such document is read. Runs at
   * most once per {@link SEED_CHECK_MS} per profile while the versions keep matching.
   */
  private async revalidateSeeded(deploymentKey: string): Promise<void> {
    const sdk = this.sdk
    if (!sdk || this.seeded.size === 0) return
    const versions = JSON.stringify([...this.seeded].sort())
    if (Date.now() - lastSeedCheck(deploymentKey, versions) < SEED_CHECK_MS) return
    try {
      const latest = await sdk.contracts.getLatestVersions({ contractIds: [...this.seeded.keys()] })
      let current = true
      for (const [id, version] of [...this.seeded]) {
        const now = latest.get(id)?.version
        if (now !== undefined && now !== version) {
          current = false
          await this.refreshSeeded(id)
        }
      }
      if (current) recordSeedCheck(deploymentKey, versions)
    } catch {
      // A failed check keeps the seeded contracts; the SDK's own staleness check still applies.
    }
  }

  /**
   * Drop a seeded contract from the SDK's cache and fetch the current one. True when it was
   * seeded and was refetched (the caller may retry its read once). Used when the versions
   * differ, and when a read names a document type the seeded contract does not have.
   */
  private async refreshSeeded(id: string): Promise<boolean> {
    const sdk = this.sdk
    if (!sdk || !this.seeded.delete(id)) return false
    try {
      const { Identifier } = await import('@dashevo/evo-sdk')
      sdk.wasm.removeCachedContract(Identifier.fromBase58(id))
      return (await sdk.contracts.fetch(id)) !== undefined
    } catch {
      return false
    }
  }

  private async preload(contractIds: readonly string[]): Promise<void> {
    const sdk = this.sdk
    if (!sdk) return
    await Promise.all(
      contractIds.map((id) =>
        sdk.contracts.fetch(id).catch(() => {
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
    this.seeded = new Map()
    setStaleContractHandler(null)
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
