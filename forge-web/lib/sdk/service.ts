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
 *
 * **Connections are generations behind one stable handle.** A trusted connection fetches the
 * quorum keys once, at connect, and never again for reads: wasm-sdk's `context_provider.rs`
 * builds its provider with `with_refetch_if_not_found(false)`, and the refresh it has
 * (`refresh_quorums`) is crate-private and runs only before a broadcast. Once the network
 * rotates past the prefetched quorums every read fails with "Quorum not found in cache"
 * (D-024), and a connection whose nodes all failed can stay unusable (D-702). From JS the only
 * refresh is a new connection, so the service builds one and swaps it in once it is connected
 * and warm. Callers hold {@link EvoSdkService.getSdk}'s handle, which forwards each call to the
 * connection that is current at that moment: a call already running finishes on the
 * connection it started on, and a writer holding the handle keeps working across a swap.
 * A new connection is built:
 *   - every {@link REFRESH_MS} while the tab is visible, before the keys go stale;
 *   - when a read fails on stale keys or on no usable node: one reconnect, then one retry;
 *   - before a write whose SDK call never refreshes the keys itself ({@link EvoSdkService.ensureFresh}):
 *     wasm-sdk's `identityCreate` verifies its result against the connection's keys as they are
 *     (L-06), unlike the broadcast facade's calls, which run `refresh_quorums` first.
 * A connect that fails is retried with backoff (D-058). Every connection is trusted: a
 * failure never falls back to unverified reads.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS, type Network } from '../constants'
import { dapiBudget, installDapiFetchGate } from './budget'
import { loadContractSnapshots } from './contract-seed'
import { followSdkVersion, setStaleContractHandler } from './query'
import { compileWasm, onWasmProgress, type DownloadProgress } from './wasm-fetch'

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

/** One connected, warmed SDK and the contracts it was seeded with (id → snapshot version). */
export interface Connection {
  readonly sdk: EvoSDK
  readonly seeded: Map<string, number>
}

/** Reconnect this often while the tab is visible, well inside a quorum's lifetime (D-024). */
export const REFRESH_MS = 5 * 60_000
/** A write that needs fresh quorum keys ({@link EvoSdkService.ensureFresh}) reuses a connection this young. */
export const FRESH_WRITE_MS = 30_000
/** A failed read triggers a reconnect at most this often. */
export const RECOVER_GAP_MS = 15_000
/** Before reconnecting after "no available addresses", wait out rate-limit holds up to this. */
export const RECOVER_MAX_WAIT_MS = 15_000
/** Waits before retrying a failed connect (the last one repeats). */
export const CONNECT_BACKOFF_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000, 120_000]
/** A page mount after a failed connect starts a new attempt at most this often. */
export const MIN_ATTEMPT_GAP_MS = 3_000
/** A connect (quorum prefetch + contract warm-up) that takes longer than this is abandoned. */
export const CONNECT_TIMEOUT_MS = 60_000

/** The connection's state, for the loading and unreachable UI. */
export type SdkStatus =
  | { readonly phase: 'idle' }
  /** The SDK's WebAssembly is downloading (first connect only). */
  | { readonly phase: 'downloading'; readonly progress: DownloadProgress }
  | { readonly phase: 'connecting' }
  | { readonly phase: 'ready' }
  /** The connect failed; `retryAt` is when the next automatic attempt runs (epoch ms). */
  | { readonly phase: 'error'; readonly message: string; readonly retryAt: number | null }

/** A read failed because its connection went stale, not because of what it asked. */
export function isStaleConnectionError(e: unknown): boolean {
  return /quorum not found in cache|no available addresses/i.test(messageOf(e))
}

/**
 * Facade methods that only read, so running one again on a new connection is harmless. Every
 * other method (broadcasts, creates, waits) runs once, on the current connection.
 */
const RETRYABLE_READS = new Set([
  'query', 'get', 'count', 'composite', 'chained', 'fetch', 'fetchUnproved', 'getMany', 'getLatestVersions',
  'balance', 'balances', 'nonce', 'contractNonce', 'keysRemainingBudgets', 'getKeys', 'status',
  'current', 'info', 'members', 'currentQuorumsInfo', 'resolveName', 'username', 'usernames',
  'sum', 'average', 'ranked', 'having', 'history', 'pathElements',
])

/** The EvoSDK facades (evo-sdk 4.2 `sdk.d.ts`). */
const FACADE_NAMES = new Set([
  'addresses', 'documents', 'identities', 'contracts', 'tokens', 'dpns', 'epoch', 'protocol',
  'stateTransitions', 'system', 'group', 'contractGroups', 'voting', 'shielded', 'encryptedFor',
  'moderationCharters',
])

type Connector = (config: EvoSdkConfig) => Promise<Connection>

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    const m = (e as { message?: unknown } | null)?.message
    return typeof m === 'string' ? m : String(e)
  } catch {
    return ''
  }
}

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

type AnyFn = (...args: unknown[]) => unknown
type Facades = Record<string, Record<string, AnyFn>>

export class EvoSdkService {
  private current: Connection | null = null
  /** When {@link current} went live: its quorum keys are this old. */
  private installedAt = -Infinity
  private generationNo = 0
  private initPromise: Promise<void> | null = null
  private config: EvoSdkConfig | null = null
  private status: SdkStatus = { phase: 'idle' }
  private readonly listeners = new Set<() => void>()
  private refreshing: Promise<boolean> | null = null
  private lastRecoverAt = -Infinity
  private refreshTimer: unknown = null
  private refreshDue = false
  private retryTimer: unknown = null
  private failures = 0
  private lastAttemptAt = -Infinity
  private recoveries = 0
  private readonly handle: EvoSDK

  constructor(
    private readonly connector: Connector = connectTrusted,
    private readonly clock: Clock = realClock,
  ) {
    this.handle = this.makeHandle()
    onWasmProgress((progress) => {
      const phase = this.status.phase
      if (phase === 'idle' || phase === 'downloading' || phase === 'connecting') {
        this.setStatus({ phase: 'downloading', progress })
      }
    })
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!visible()) return
        if (this.refreshDue) void this.refresh()
        if (this.status.phase === 'error' && this.retryTimer === null) this.scheduleRetry()
      })
    }
  }

  /** Whether the SDK is connected and its contracts are preloaded. */
  get isReady(): boolean {
    return this.current !== null
  }

  /**
   * Whether the live connection proof-checks its reads. A trusted connect prefetches the
   * quorum keys and verifies every plain `.query()` against them (design-freeze-2 #5); any
   * other connection would return node answers unchecked. The trust panel derives its
   * "proofs" state from this rather than assuming it. Every connection this service builds
   * is trusted.
   */
  get isTrusted(): boolean {
    return this.isReady
  }

  /** Increments whenever a new connection goes live (the quorum cross-check follows it). */
  get generation(): number {
    return this.generationNo
  }

  /**
   * Increments each time Platform becomes reachable again after an outage, so views re-read
   * once rather than on every routine reconnect.
   */
  get recoveryCount(): number {
    return this.recoveries
  }

  getStatus(): SdkStatus {
    return this.status
  }

  /** Follow status and connection changes. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Connect (idempotent). Re-initializes only if the network changed; if new contract ids
   * appear for the same network they are preloaded without tearing down the connection.
   */
  async initialize(config: EvoSdkConfig): Promise<void> {
    if (this.current && this.config && this.config.network === config.network) {
      const missing = config.contractIds.filter((id) => !this.config?.contractIds.includes(id))
      if (missing.length > 0) {
        this.config = { ...this.config, contractIds: [...this.config.contractIds, ...missing] }
        await preload(this.current.sdk, missing)
      }
      return
    }
    if (this.initPromise) {
      await this.initPromise
      if (this.config?.network === config.network) return this.initialize(config)
    }
    if (this.config && this.config.network !== config.network) {
      this.cleanup()
    }
    const known = this.config?.contractIds ?? []
    this.config = { ...config, contractIds: [...new Set([...known, ...config.contractIds])] }
    // Every page mount lands here: after a failure, start a new attempt at most every
    // MIN_ATTEMPT_GAP_MS, else report the last failure (the backoff retries on its own).
    if (this.status.phase === 'error' && this.clock.now() - this.lastAttemptAt < MIN_ATTEMPT_GAP_MS) {
      throw new Error(this.status.message)
    }
    await this.connectFirst()
  }

  /** The first connect for the configured network, and each retry of it after a failure. */
  private connectFirst(): Promise<void> {
    if (this.initPromise) return this.initPromise
    const config = this.config
    if (config === null) return Promise.reject(new Error('cannot connect before initialize()'))
    this.clearRetry()
    this.lastAttemptAt = this.clock.now()
    if (this.status.phase !== 'downloading') this.setStatus({ phase: 'connecting' })
    const run = this.connector(config).then(
      (connection) => {
        if (this.config !== config) return
        this.install(connection)
        this.scheduleRefresh()
      },
      (e: unknown) => {
        if (this.config === config) this.fail(e)
        throw e
      },
    )
    this.initPromise = run
    const clear = (): void => {
      if (this.initPromise === run) this.initPromise = null
    }
    run.then(clear, clear)
    return run
  }

  /** Platform is unreachable: report it and schedule the next attempt. */
  private fail(cause: unknown): void {
    this.failures++
    this.setStatus({ phase: 'error', message: messageOf(cause) || 'could not reach Platform', retryAt: null })
    this.scheduleRetry()
  }

  /** Try a failed connect again now (the "Try again" button). */
  retryNow(): void {
    if (this.status.phase !== 'error') return
    void this.connectFirst().catch(() => undefined)
  }

  private scheduleRetry(): void {
    this.clearRetry()
    if (this.status.phase !== 'error') return
    // A hidden tab waits: the visibilitychange listener schedules the retry when it is shown.
    if (!visible()) {
      this.setStatus({ ...this.status, retryAt: null })
      return
    }
    const wait = CONNECT_BACKOFF_MS[Math.min(this.failures, CONNECT_BACKOFF_MS.length) - 1] ?? 5_000
    this.setStatus({ ...this.status, retryAt: this.clock.now() + wait })
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null
      void this.connectFirst().catch(() => undefined)
    }, wait)
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) this.clock.clearTimeout(this.refreshTimer)
    this.refreshTimer = this.clock.setTimeout(() => {
      this.refreshTimer = null
      if (visible()) void this.refresh()
      else this.refreshDue = true
    }, REFRESH_MS)
  }

  private install(connection: Connection): void {
    const first = this.current === null
    this.current = connection
    this.installedAt = this.clock.now()
    this.generationNo++
    if (this.failures > 0) {
      // Back from an outage (a scheduled retry, "Try again", or a refresh that got through).
      this.failures = 0
      this.clearRetry()
      this.recoveries++
    }
    followSdkVersion(connection.sdk)
    // Bound to this connection: a later one installs its own.
    setStaleContractHandler((id) => refreshSeeded(connection, id))
    // Off the critical path: are the seeded contracts still the network's current versions?
    if (first && this.config) void revalidateSeeded(connection, NETWORKS[this.config.network].key)
    this.setStatus({ phase: 'ready' })
  }

  /**
   * Build a new connection (a fresh quorum-key prefetch) and swap it in once it is connected
   * and warm. Concurrent calls share one attempt. On failure the current connection stays;
   * resolves to whether a new one went live.
   */
  refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing
    const config = this.config
    if (config === null || this.current === null) return Promise.resolve(false)
    this.refreshDue = false
    const run = this.connector(config).then(
      (connection) => {
        if (this.config !== config || this.current === null) return false
        this.install(connection)
        return true
      },
      () => false,
    )
    this.refreshing = run
    void run.then(() => {
      this.refreshing = null
      if (this.config === config && this.current !== null) this.scheduleRefresh()
    })
    return run
  }

  /**
   * Before a write whose result is proof-checked against the connection's quorum keys by an SDK
   * call that never refreshes them (wasm-sdk `identityCreate`, L-06): build a new connection
   * unless the current one is at most `maxAgeMs` old. Resolves to whether the connection is that
   * fresh; a failed rebuild keeps the current one (the caller checks what landed instead).
   */
  async ensureFresh(maxAgeMs = FRESH_WRITE_MS): Promise<boolean> {
    if (this.current === null) return false
    if (this.clock.now() - this.installedAt <= maxAgeMs) return true
    return this.refresh()
  }

  /** Force a fresh connection (e.g. after a network drop). Preserves the config. */
  async reconnect(): Promise<void> {
    if (!this.config) throw new Error('cannot reconnect before initialize()')
    if (this.current === null) return this.connectFirst()
    if (!(await this.refresh())) throw new Error('could not reconnect to Platform')
  }

  /**
   * Run a read; if it failed because its connection went stale (rotated quorum keys, no usable
   * node), reconnect once and run it again on the new connection. A read whose connection was
   * already replaced just runs again; a new reconnect starts at most every
   * {@link RECOVER_GAP_MS}.
   */
  async withRecovery<T>(read: (sdk: EvoSDK) => Promise<T>): Promise<T> {
    const used = this.live()
    try {
      return await read(used.sdk)
    } catch (e) {
      if (!isStaleConnectionError(e)) throw e
      if (this.current === used && !(await this.recover(e))) throw e
      const now = this.current
      if (now === null || now === used) throw e
      return read(now.sdk)
    }
  }

  private async recover(cause: unknown): Promise<boolean> {
    if (this.refreshing !== null) return this.refreshing
    if (this.clock.now() - this.lastRecoverAt < RECOVER_GAP_MS) return false
    this.lastRecoverAt = this.clock.now()
    // Rate-limited nodes (budget.ts): reconnecting at once would go straight back to them.
    if (/no available addresses/i.test(messageOf(cause))) {
      const wait = Math.min(dapiBudget.retryAfterMs(), RECOVER_MAX_WAIT_MS)
      if (wait > 0) await new Promise((r) => this.clock.setTimeout(() => r(undefined), wait))
    }
    const renewed = await this.refresh()
    if (!renewed && this.current !== null && this.status.phase === 'ready') {
      // The connection can no longer read and a new one cannot be built: Platform is
      // unreachable. Pages drop to their cached content under the unreachable banner, and
      // the connect is retried with backoff.
      this.fail(cause)
    }
    return renewed
  }

  /** The connected SDK (a handle that follows reconnects). Throws if not yet initialized. */
  getSdk(): EvoSDK {
    this.live()
    return this.handle
  }

  private live(): Connection {
    if (this.current === null) throw new Error('EvoSDK not initialized — call initialize() first')
    return this.current
  }

  /** Drop the connection and reset state. */
  cleanup(): void {
    this.current = null
    setStaleContractHandler(null)
    this.config = null
    this.initPromise = null
    this.refreshing = null
    this.failures = 0
    this.clearRetry()
    if (this.refreshTimer !== null) this.clock.clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    this.setStatus({ phase: 'idle' })
  }

  private setStatus(status: SdkStatus): void {
    this.status = status
    this.notify()
  }

  private notify(): void {
    this.listeners.forEach((l) => l())
  }

  /**
   * The handle callers hold. Each property is read from the current connection when it is
   * used; the read methods of the facades go through {@link withRecovery}.
   */
  private makeHandle(): EvoSDK {
    const facades = new Map<string, object>()
    const facade = (name: string): object => {
      let proxy = facades.get(name)
      if (proxy === undefined) {
        proxy = new Proxy(
          {},
          {
            get: (_target, method) => {
              const value = (this.live().sdk as unknown as Facades)[name]?.[method as string]
              if (typeof value !== 'function' || typeof method !== 'string') return value
              const call = (sdk: EvoSDK, args: unknown[]): unknown => (sdk as unknown as Facades)[name]![method]!(...args)
              if (!RETRYABLE_READS.has(method)) return (...args: unknown[]) => call(this.live().sdk, args)
              return (...args: unknown[]) => this.withRecovery((sdk) => call(sdk, args) as Promise<unknown>)
            },
          },
        )
        facades.set(name, proxy)
      }
      return proxy
    }
    return new Proxy({} as EvoSDK, {
      get: (_target, prop) => {
        // Never look like a thenable (the handle is returned from async functions).
        if (prop === 'then' || this.current === null) return undefined
        if (typeof prop === 'string' && FACADE_NAMES.has(prop)) return facade(prop)
        const sdk = this.current.sdk as unknown as Record<PropertyKey, unknown>
        const value = sdk[prop]
        return typeof value === 'function' ? (value as AnyFn).bind(sdk) : value
      },
    })
  }
}

async function preload(sdk: EvoSDK, contractIds: readonly string[]): Promise<void> {
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

/**
 * Add the deployment's contract snapshots (`contract-seed.ts`) to the SDK's contract cache,
 * so no page spends a `getDataContract` request on them. A snapshot that fails to decode is
 * skipped: {@link preload} then fetches that contract as before.
 */
async function seed(sdk: EvoSDK, deploymentKey: string): Promise<Map<string, number>> {
  const seeded = new Map<string, number>()
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
async function revalidateSeeded(connection: Connection, deploymentKey: string): Promise<void> {
  const { sdk, seeded } = connection
  if (seeded.size === 0) return
  const versions = JSON.stringify([...seeded].sort())
  if (Date.now() - lastSeedCheck(deploymentKey, versions) < SEED_CHECK_MS) return
  try {
    const latest = await sdk.contracts.getLatestVersions({ contractIds: [...seeded.keys()] })
    let current = true
    for (const [id, version] of [...seeded]) {
      const now = latest.get(id)?.version
      if (now !== undefined && now !== version) {
        current = false
        await refreshSeeded(connection, id)
      }
    }
    if (current) recordSeedCheck(deploymentKey, versions)
  } catch {
    // A failed check keeps the seeded contracts; the SDK's own staleness check still applies.
  }
}

/**
 * Drop a seeded contract from the connection's cache and fetch the current one. True when it
 * was seeded and was refetched (the caller may retry its read once). Used when the versions
 * differ, and when a read names a document type the seeded contract does not have.
 */
async function refreshSeeded(connection: Connection, id: string): Promise<boolean> {
  const { sdk, seeded } = connection
  if (!seeded.delete(id)) return false
  try {
    const { Identifier } = await import('@dashevo/evo-sdk')
    sdk.wasm.removeCachedContract(Identifier.fromBase58(id))
    return (await sdk.contracts.fetch(id)) !== undefined
  } catch {
    return false
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/** Build, connect and warm a trusted connection for `config`. */
async function connectTrusted(config: EvoSdkConfig): Promise<Connection> {
  // Every DAPI request this page makes goes through the shared request budget (`budget.ts`).
  installDapiFetchGate(NETWORKS[config.network].dapiAddresses)
  // Start the wasm download (a separate asset with its own stall timer, wasm-fetch.ts) next to
  // the SDK's JS chunk rather than after it. Both load on first data need, never in the
  // first-paint bundle.
  const wasm = compileWasm()
  wasm.catch(() => undefined)
  const evo = await import('@dashevo/evo-sdk')
  await wasm
  await evo.ensureInitialized()
  // A slow link may take minutes over the download; the connect itself gets a deadline, so a
  // hung quorum service fails (and is retried) instead of spinning forever.
  return withTimeout(connectAndWarm(evo.EvoSDK, config), CONNECT_TIMEOUT_MS, 'Connecting to Platform')
}

async function connectAndWarm(EvoSDKClass: typeof import('@dashevo/evo-sdk').EvoSDK, config: EvoSdkConfig): Promise<Connection> {
  // `banFailedAddress: false`: a failed attempt only drops the node from the SDK's sticky
  // rotation and the next attempt goes to another node (rs-dapi-client
  // `update_address_ban_status`); nothing is banned, so a burst of refusals can no longer
  // leave the SDK with "no available addresses" (D-102, D-902). The trade-off: the SDK no
  // longer keeps a node that is really down out for minutes. The gate does that instead, for
  // `DOWN_MS`, from network errors, HTTP 5xx and gRPC `Unavailable`. It also turns off the
  // SDK's DPNS-registration owner failover, which this app does not use (it registers no names).
  const options = { settings: { timeoutMs: config.timeoutMs ?? 8000, banFailedAddress: false } }
  let sdk: EvoSDK
  if (config.network === 'devnet') {
    // A named devnet: trusted quorum keys from `quorums.<name>.networks.dash.org` (or the
    // deployment file's quorumBaseUrl); DAPI from the configured list, else discovered by
    // the trusted context.
    const devnet = NETWORKS.devnet
    if (devnet.devnetName === null) {
      throw new Error('devnet selected without NEXT_PUBLIC_DEVNET_NAME')
    }
    sdk = new EvoSDKClass({
      ...options,
      network: 'devnet',
      trusted: true,
      devnetName: devnet.devnetName,
      ...(devnet.quorumBaseUrl !== null ? { quorumUrl: devnet.quorumBaseUrl } : {}),
      ...(devnet.dapiAddresses.length > 0 ? { addresses: [...devnet.dapiAddresses] } : {}),
    })
  } else {
    sdk = config.network === 'mainnet' ? EvoSDKClass.mainnetTrusted(options) : EvoSDKClass.testnetTrusted(options)
  }
  await sdk.connect()
  // Seed the bundled contract snapshots, then preload what is still missing, BEFORE the
  // connection goes live so callers never see an unwarmed SDK.
  const seeded = await seed(sdk, NETWORKS[config.network].key)
  await preload(sdk, config.contractIds.filter((id) => !seeded.has(id)))
  return { sdk, seeded }
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
