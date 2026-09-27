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
 *   - before a write whose SDK call never refreshes the keys itself (L-06, {@link EvoSdkService.ensureFresh}).
 * A connect that fails is retried with backoff (D-058). Every connection is trusted: a
 * failure never falls back to unverified reads.
 *
 * What a new connection takes over from the one it replaces:
 *   - the protocol version: wasm-sdk already seeds each new SDK at the version the last one
 *     learned (`protocol_version_store`, mainnet/testnet; a devnet's floor is current), and the
 *     handle's `version()` never reports lower than a version a connection proved;
 *   - which bundled contract snapshots turned out outdated: those are fetched, not seeded
 *     again. It preloads only the contracts pages used recently, not every id ever named.
 * A refreshed connection is installed only while no write is running and the last one ended
 * {@link WRITE_SETTLE_MS} ago: rs-sdk keeps nonces per `Sdk` instance, and a fresh cache asking
 * a node a block behind would sign a nonce this tab already used.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS, type Network } from '../constants'
import { dapiBudget, installDapiFetchGate } from './budget'
import { loadContractSnapshots } from './contract-seed'
import { followSdkVersion, setStaleContractHandler } from './query'
import { compileWasm, onWasmProgress, type DownloadProgress } from './wasm-fetch'
import { setWriteHold } from './write'

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

/** What a new connection takes over from the one it replaces. */
export interface Carry {
  /**
   * Bundled contract snapshots found outdated on an earlier connection: fetched, not seeded,
   * so a refresh does not bring the old version back.
   */
  readonly outdated: ReadonlySet<string>
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
/** A connect (quorum prefetch + contract warm-up) that takes longer than this is abandoned. */
export const CONNECT_TIMEOUT_MS = 60_000
/** After a write ends, how long a connection swap still waits (every node has seen it by then). */
export const WRITE_SETTLE_MS = 15_000
/** Download progress reaches the UI at most this often. */
export const PROGRESS_INTERVAL_MS = 250

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
 * A read failed because Platform could not be reached (a stale connection, a transport error,
 * a timeout, a node that is down or rate-limited), not because of what it asked or what came
 * back. A proof or decode failure is not one of these: it must surface, never be papered over
 * with content read earlier.
 */
export function isUnreachableError(e: unknown): boolean {
  if (isStaleConnectionError(e)) return true
  return /failed to fetch|fetch failed|networkerror|network error|load failed|timed out|timeout|deadline exceeded|\bunavailable\b|resourceexhausted|resource exhausted|transport error|connection (?:refused|reset)|HTTP 5\d\d|could not reach platform|can't reach platform/i.test(
    messageOf(e),
  )
}

/**
 * Facade methods that only read, keyed `facade.method`, so running one again on a new
 * connection is harmless. Every other method (broadcasts, creates, replaces, deletes, waits,
 * identity updates) runs once, on the current connection. The `*WithProof` variants are the
 * same reads returning their proof metadata as well.
 */
const READS: Readonly<Record<string, readonly string[]>> = {
  addresses: ['get', 'getMany'],
  documents: ['query', 'get', 'count', 'composite', 'chained', 'history', 'sum', 'average', 'ranked', 'having'],
  identities: [
    'fetch', 'fetchUnproved', 'getKeys', 'nonce', 'contractNonce', 'keysRemainingBudgets', 'balance', 'balances',
    'balanceAndRevision', 'byPublicKeyHash', 'byNonUniquePublicKeyHash', 'contractKeys', 'tokenBalances',
  ],
  contracts: ['fetch', 'getHistory', 'getMany', 'getByRange', 'getLatestVersions'],
  dpns: ['resolveName', 'username', 'usernames', 'getUsernameByName'],
  epoch: ['current', 'epochsInfo', 'finalizedInfos'],
  system: ['status', 'currentQuorumsInfo', 'totalCreditsInPlatform', 'pathElements'],
  contractGroups: ['info', 'members', 'forContract'],
  group: ['info', 'infos', 'members'],
}

export const RETRYABLE_READS: ReadonlySet<string> = new Set(
  Object.entries(READS).flatMap(([facade, methods]) => methods.flatMap((m) => [`${facade}.${m}`, `${facade}.${m}WithProof`])),
)

/** The EvoSDK facades (evo-sdk 4.2 `sdk.d.ts`). */
const FACADE_NAMES = new Set([
  'addresses', 'documents', 'identities', 'contracts', 'tokens', 'dpns', 'epoch', 'protocol',
  'stateTransitions', 'system', 'group', 'contractGroups', 'voting', 'shielded', 'encryptedFor',
  'moderationCharters',
])

type Connector = (config: EvoSdkConfig, carry: Carry, signal: AbortSignal) => Promise<Connection>

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

/** The protocol version `sdk` has learned, or undefined. */
function versionOf(sdk: EvoSDK): number | undefined {
  try {
    const v = sdk.version()
    return Number.isInteger(v) && v > 0 ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * Free a connection's wasm SDK. Only for a connection no call is using: wasm-bindgen's explicit
 * `free()` takes ownership and traps if an async call still borrows the object (the service
 * frees a retired connection once its last call returned, {@link EvoSdkService.retire}).
 */
function dispose(connection: Connection): void {
  try {
    ;(connection.sdk.wasm as unknown as { free?: () => void }).free?.()
  } catch {
    // Not connected, or already freed: nothing to release.
  }
}

type AnyFn = (...args: unknown[]) => unknown
type Facades = Record<string, Record<string, AnyFn>>

export class EvoSdkService {
  private current: Connection | null = null
  /** When {@link current} went live: its quorum keys are this old. */
  private installedAt = -Infinity
  private generationNo = 0
  /** Bumped by a network switch and by `cleanup()`: an attempt started under another epoch is dropped. */
  private epoch = 0
  private network: Network | null = null
  private contractIds: string[] = []
  private timeoutMs: number | undefined
  private initPromise: Promise<void> | null = null
  private status: SdkStatus = { phase: 'idle' }
  private readonly listeners = new Set<() => void>()
  private refreshing: Promise<boolean> | null = null
  private recovering: Promise<boolean> | null = null
  private lastRecoverAt = -Infinity
  private refreshTimer: unknown = null
  private refreshDue = false
  private retryTimer: unknown = null
  private failures = 0
  private recoveries = 0
  /** The highest protocol version any connection learned (never lowered by a new one). */
  private learnedVersion: number | undefined
  /** Contracts read through the handle: id → last use (a refresh preloads the recent ones). */
  private readonly usedContracts = new Map<string, number>()
  /** Bundled snapshots found outdated: later connections fetch these instead of seeding them. */
  private readonly outdated = new Set<string>()
  private runningWrites = 0
  private lastWriteEnd = -Infinity
  private writeWaiters: (() => void)[] = []
  /**
   * A read failed on the live connection: swap as soon as the new one is ready, even under a
   * write. A connection that can no longer read holds no nonce state worth keeping, and a
   * write whose own read is waiting on the recovery would otherwise never end.
   */
  private swapUrgent = false
  private progressAt = -Infinity
  private progressTimer: unknown = null
  private latest: DownloadProgress = { loaded: 0, total: 0 }
  private readonly aborts = new Set<AbortController>()
  /** Calls running through the handle, per connection. */
  private readonly inFlight = new Map<Connection, number>()
  /** Replaced connections waiting for their last call before they are freed. */
  private readonly retired = new Set<Connection>()
  private readonly handle: EvoSDK

  constructor(
    private readonly connector: Connector = connectTrusted,
    private readonly clock: Clock = realClock,
  ) {
    this.handle = this.makeHandle()
    onWasmProgress((progress) => this.onProgress(progress))
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

  /** Increments whenever a new connection goes live. */
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

  /** The config the next connect uses (the ids every mount asked for, in order). */
  private get config(): EvoSdkConfig | null {
    if (this.network === null) return null
    return { network: this.network, contractIds: [...this.contractIds], ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}) }
  }

  /**
   * Connect (idempotent). Re-initializes only if the network changed; new contract ids for
   * the same network are added to the config (never replacing it) and preloaded on the live
   * connection without tearing it down.
   */
  async initialize(config: EvoSdkConfig): Promise<void> {
    if (this.network !== null && this.network !== config.network) this.cleanup()
    this.network = config.network
    if (this.timeoutMs === undefined) this.timeoutMs = config.timeoutMs
    const missing = config.contractIds.filter((id) => !this.contractIds.includes(id))
    this.contractIds.push(...missing)
    if (this.current !== null) {
      if (missing.length > 0) await this.track(this.current, (sdk) => preload(sdk, missing))
      return
    }
    // Every page mount lands here. During an outage it waits for the scheduled retry
    // (`retryAt`) rather than starting another attempt; only "Try again" skips the wait.
    if (this.status.phase === 'error') {
      if (this.initPromise) return this.initPromise
      throw new Error(this.status.message)
    }
    await this.connectFirst()
  }

  /** The first connect for the configured network, and each retry of it after a failure. */
  private connectFirst(): Promise<void> {
    if (this.initPromise) return this.initPromise
    const config = this.config
    if (config === null) return Promise.reject(new Error('cannot connect before initialize()'))
    const epoch = this.epoch
    this.clearRetry()
    if (this.status.phase !== 'downloading') this.setStatus({ phase: 'connecting' })
    const run = this.attempt(config).then(
      (connection) => {
        if (this.epoch !== epoch) {
          dispose(connection)
          return
        }
        this.install(connection)
        this.scheduleRefresh()
      },
      (e: unknown) => {
        if (this.epoch === epoch) this.fail(e)
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

  /** Build a connection for `config` with what the current one can hand over; abortable by cleanup. */
  private attempt(base: EvoSdkConfig): Promise<Connection> {
    const config = { ...base, contractIds: this.preloadIds() }
    const controller = new AbortController()
    this.aborts.add(controller)
    const run = this.connector(config, { outdated: this.outdated }, controller.signal)
    void run.then(
      () => this.aborts.delete(controller),
      () => this.aborts.delete(controller),
    )
    return run
  }

  /**
   * The contract ids a connection preloads: all of them for the first connect; for a refresh
   * only those pages read in the last two refresh periods (the rest load on first use).
   */
  private preloadIds(): string[] {
    if (this.current === null) return [...this.contractIds]
    const cutoff = this.clock.now() - 2 * REFRESH_MS
    return [...this.usedContracts].filter(([, at]) => at >= cutoff).map(([id]) => id)
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
    this.retryConnect()
    // The live connection cannot read; nothing a write holds on it is worth waiting for.
    this.urgeSwap()
  }

  /** Retry a failed connect: the first connect if there is none, else a refresh. */
  private retryConnect(): void {
    if (this.current === null) void this.connectFirst().catch(() => undefined)
    else void this.refresh()
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
      this.retryConnect()
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
    const previous = this.current
    if (previous !== null) this.learn(previous.sdk)
    this.current = connection
    this.installedAt = this.clock.now()
    this.generationNo++
    // Observable without React (the e2e suite waits for a swap to go live on it).
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.dataset['sdkGeneration'] = String(this.generationNo)
    }
    if (this.failures > 0) {
      // Back from an outage (a scheduled retry, "Try again", or a refresh that got through).
      this.failures = 0
      this.clearRetry()
      this.recoveries++
    }
    // The normalizer follows the handle, which never reports below a version already proved.
    followSdkVersion(this.handle)
    // Bound to this connection: a later one installs its own.
    const replaced = (id: string): void => {
      this.outdated.add(id)
    }
    // Counted like any call, so a swap does not free the connection under them.
    setStaleContractHandler((id) => this.track(connection, () => refreshSeeded(connection, id, replaced)))
    // Off the critical path, on every connection (at most once an hour while the versions
    // match): are the seeded contracts still the network's current versions?
    if (this.network !== null) {
      const key = NETWORKS[this.network].key
      void this.track(connection, () => revalidateSeeded(connection, key, replaced))
    }
    this.setStatus({ phase: 'ready' })
    if (previous !== null) this.retire(previous)
  }

  /**
   * Build a new connection (a fresh quorum-key prefetch) and swap it in once it is connected
   * and warm, and no write needs the old one. Concurrent calls share one attempt. On failure
   * the current connection stays; resolves to whether a new one went live.
   */
  refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing
    const config = this.config
    if (config === null || this.current === null) return Promise.resolve(false)
    const epoch = this.epoch
    this.refreshDue = false
    const run = this.attempt(config).then(
      async (connection) => {
        // A write can hold the swap back; a connection that waited a whole refresh period
        // has keys as old as the one it would replace, so build a fresh one instead.
        if (!(await this.writesSettled(REFRESH_MS)) || this.epoch !== epoch || this.current === null) {
          dispose(connection)
          return false
        }
        this.install(connection)
        return true
      },
      (e: unknown) => {
        // A retry during an outage that failed again: report it and back off further.
        if (this.epoch === epoch && this.status.phase === 'error') this.fail(e)
        return false
      },
    )
    this.refreshing = run
    void run.then(() => {
      if (this.refreshing !== run) return
      this.refreshing = null
      this.swapUrgent = false
      if (this.epoch === epoch && this.current !== null) this.scheduleRefresh()
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
   * Run `write` as a write the connection must not be swapped under (the SDK's per-instance
   * nonce cache, see the module comment). A refresh that completes meanwhile waits.
   */
  async holdForWrite<T>(write: () => Promise<T>): Promise<T> {
    this.runningWrites++
    try {
      return await write()
    } finally {
      this.runningWrites--
      this.lastWriteEnd = this.clock.now()
      if (this.runningWrites === 0) this.wakeWriteWaiters()
    }
  }

  /**
   * True once no write runs and the last ended {@link WRITE_SETTLE_MS} ago, or at once when a
   * recovery or "Try again" needs the swap ({@link swapUrgent}); false if that takes longer
   * than `maxWaitMs`.
   */
  private async writesSettled(maxWaitMs: number): Promise<boolean> {
    const deadline = this.clock.now() + maxWaitMs
    for (;;) {
      if (this.swapUrgent) return true
      const now = this.clock.now()
      if (now >= deadline) return false
      const settle = this.runningWrites > 0 ? Infinity : this.lastWriteEnd + WRITE_SETTLE_MS - now
      if (settle <= 0) return true
      await new Promise<void>((r) => {
        this.writeWaiters.push(r)
        this.clock.setTimeout(r, Math.min(settle, deadline - now))
      })
    }
  }

  /**
   * A swap is needed now (a failing connection, or the user asked): the refresh in flight
   * stops waiting on writes. No-op without one, so the flag never outlives its refresh.
   */
  private urgeSwap(): void {
    if (this.refreshing === null) return
    this.swapUrgent = true
    this.wakeWriteWaiters()
  }

  private wakeWriteWaiters(): void {
    const waiters = this.writeWaiters
    this.writeWaiters = []
    waiters.forEach((w) => w())
  }

  /**
   * Run a read; if it failed because its connection went stale (rotated quorum keys, no usable
   * node), reconnect once and run it again on the new connection. A read whose connection was
   * already replaced just runs again; a new reconnect starts at most every
   * {@link RECOVER_GAP_MS}, and reads failing meanwhile share it.
   */
  async withRecovery<T>(read: (sdk: EvoSDK) => Promise<T>): Promise<T> {
    const used = this.live()
    try {
      return await this.track(used, read)
    } catch (e) {
      if (!isStaleConnectionError(e)) throw e
      if (this.current === used && !(await this.recover(e, used))) throw e
      const now = this.current
      if (now === null || now === used) throw e
      return this.track(now, read)
    }
  }

  /** One recovery (the rate-limit wait and the reconnect) that every failing read shares. */
  private recover(cause: unknown, used: Connection): Promise<boolean> {
    if (this.recovering !== null) return this.recovering
    if (this.refreshing !== null) {
      // A routine refresh waiting on a write: this connection is failing, swap when ready.
      this.urgeSwap()
      return this.refreshing
    }
    // During an outage the retry timer owns reconnects: reads failing meanwhile neither
    // reconnect nor push the next retry back.
    if (this.status.phase === 'error') return Promise.resolve(false)
    if (this.clock.now() - this.lastRecoverAt < RECOVER_GAP_MS) return Promise.resolve(false)
    this.lastRecoverAt = this.clock.now()
    const run = (async (): Promise<boolean> => {
      // Rate-limited nodes (budget.ts): reconnecting at once would go straight back to them.
      if (/no available addresses/i.test(messageOf(cause))) {
        const wait = Math.min(dapiBudget.retryAfterMs(), RECOVER_MAX_WAIT_MS)
        if (wait > 0) await new Promise((r) => this.clock.setTimeout(() => r(undefined), wait))
      }
      // Replaced while waiting (a routine refresh went live): the read just runs again.
      if (this.current !== used) return this.current !== null
      const refreshing = this.refresh()
      this.urgeSwap()
      const renewed = await refreshing
      if (!renewed && this.current !== null && this.status.phase === 'ready') {
        // The connection can no longer read and a new one cannot be built: Platform is
        // unreachable. Pages drop to their cached content under the unreachable banner, and
        // the connect is retried with backoff.
        this.fail(cause)
      }
      return renewed
    })()
    this.recovering = run
    void run.then(() => {
      if (this.recovering === run) this.recovering = null
    })
    return run
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

  /** Drop the connection and reset state; attempts still running are aborted and dropped. */
  cleanup(): void {
    this.epoch++
    this.aborts.forEach((a) => a.abort())
    this.aborts.clear()
    if (this.current !== null) this.retire(this.current)
    this.current = null
    setStaleContractHandler(null)
    this.network = null
    this.contractIds = []
    this.timeoutMs = undefined
    this.initPromise = null
    this.refreshing = null
    this.swapUrgent = false
    this.recovering = null
    this.failures = 0
    this.usedContracts.clear()
    this.outdated.clear()
    this.learnedVersion = undefined
    this.clearRetry()
    if (this.refreshTimer !== null) this.clock.clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    this.setStatus({ phase: 'idle' })
  }

  /**
   * The SDK download reports progress. Only a connect waiting on it shows it (a wallet-only
   * wasm load does not move the service), at most every {@link PROGRESS_INTERVAL_MS}; once
   * every byte is in, the connect shows "Connecting…".
   */
  private onProgress(progress: DownloadProgress): void {
    if (!this.showsProgress()) return
    const done = progress.total > 0 && progress.loaded >= progress.total
    if (done) {
      if (this.progressTimer !== null) this.clock.clearTimeout(this.progressTimer)
      this.progressTimer = null
      this.setStatus({ phase: 'connecting' })
      return
    }
    const now = this.clock.now()
    const show = (): void => {
      this.progressTimer = null
      this.progressAt = this.clock.now()
      if (this.showsProgress()) this.setStatus({ phase: 'downloading', progress: this.latest })
    }
    this.latest = progress
    if (now - this.progressAt >= PROGRESS_INTERVAL_MS) show()
    else if (this.progressTimer === null) this.progressTimer = this.clock.setTimeout(show, this.progressAt + PROGRESS_INTERVAL_MS - now)
  }

  /** Only a connect that is waiting on the download shows its progress. */
  private showsProgress(): boolean {
    const p = this.status.phase
    return (p === 'connecting' || p === 'downloading') && this.initPromise !== null
  }

  private setStatus(status: SdkStatus): void {
    this.status = status
    this.notify()
  }

  private notify(): void {
    this.listeners.forEach((l) => l())
  }

  /** Free `connection` now if no call is running on it, else when the last one returns. */
  private retire(connection: Connection): void {
    if ((this.inFlight.get(connection) ?? 0) === 0) dispose(connection)
    else this.retired.add(connection)
  }

  /** Run `call` on `connection`, counted so a retired connection is freed only once idle. */
  private track<T>(connection: Connection, call: (sdk: EvoSDK) => T): T {
    this.inFlight.set(connection, (this.inFlight.get(connection) ?? 0) + 1)
    const done = (): void => {
      const left = (this.inFlight.get(connection) ?? 1) - 1
      if (left > 0) {
        this.inFlight.set(connection, left)
        return
      }
      this.inFlight.delete(connection)
      if (this.retired.delete(connection)) dispose(connection)
    }
    let result: T
    try {
      result = call(connection.sdk)
    } catch (e) {
      done()
      throw e
    }
    if (result instanceof Promise) {
      void result.then(done, done)
    } else done()
    return result
  }

  /** Remember the highest protocol version `sdk` has proved (a new connection may report its floor). */
  private learn(sdk: EvoSDK): number | undefined {
    const v = versionOf(sdk)
    if (v !== undefined && (this.learnedVersion === undefined || v > this.learnedVersion)) this.learnedVersion = v
    return this.learnedVersion
  }

  /** Note the contract a read names (a refresh preloads the recently used ones). */
  private noteContract(args: unknown[]): void {
    const first = args[0] as { dataContractId?: unknown; contractId?: unknown } | string | undefined
    let id: unknown = first
    if (typeof first !== 'string') id = typeof first?.dataContractId === 'string' ? first.dataContractId : first?.contractId
    if (typeof id === 'string') this.usedContracts.set(id, this.clock.now())
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
              if (!RETRYABLE_READS.has(`${name}.${method}`)) return (...args: unknown[]) => this.track(this.live(), (sdk) => call(sdk, args))
              return (...args: unknown[]) => {
                if (name === 'documents' || name === 'contracts') this.noteContract(args)
                return this.withRecovery((sdk) => call(sdk, args) as Promise<unknown>)
              }
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
        // Never lower than a version a connection proved: a write derives its document id at
        // this version, and Drive refuses an id derived at an older one.
        if (prop === 'version') return () => this.learn(this.live().sdk) ?? this.live().sdk.version()
        const connection = this.current
        const sdk = connection.sdk as unknown as Record<PropertyKey, unknown>
        const value = sdk[prop]
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => this.track(connection, () => (value as AnyFn).apply(sdk, args))
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
 * so no page spends a `getDataContract` request on them. `outdated` snapshots (an earlier
 * connection found the network had moved on) and any that fail to decode are skipped:
 * {@link preload} fetches those.
 */
async function seed(sdk: EvoSDK, deploymentKey: string, outdated: ReadonlySet<string>): Promise<Map<string, number>> {
  const seeded = new Map<string, number>()
  const snapshots = await loadContractSnapshots(deploymentKey).catch(() => ({}))
  const entries = Object.entries(snapshots).filter(([id]) => !outdated.has(id))
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
async function revalidateSeeded(connection: Connection, deploymentKey: string, replaced: (id: string) => void): Promise<void> {
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
        await refreshSeeded(connection, id, replaced)
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
async function refreshSeeded(connection: Connection, id: string, replaced: (id: string) => void): Promise<boolean> {
  const { sdk, seeded } = connection
  if (!seeded.delete(id)) return false
  replaced(id)
  try {
    const { Identifier } = await import('@dashevo/evo-sdk')
    sdk.wasm.removeCachedContract(Identifier.fromBase58(id))
    return (await sdk.contracts.fetch(id)) !== undefined
  } catch {
    return false
  }
}

/** Reject with `what` timed out after `ms`, aborting `controller` so the work stops spending requests. */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`))
    }, ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/** Build, connect and warm a trusted connection for `config`. */
async function connectTrusted(config: EvoSdkConfig, carry: Carry, signal: AbortSignal): Promise<Connection> {
  // Every DAPI request this page makes goes through the shared request budget (`budget.ts`).
  installDapiFetchGate(NETWORKS[config.network].dapiAddresses)
  // In a browser, start the wasm download (a separate asset with its own stall timer,
  // wasm-fetch.ts) next to the SDK's JS chunk rather than after it. Both load on first data
  // need, never in the first-paint bundle. Elsewhere (Node, the live tests) the SDK's own
  // loader brings its wasm.
  if (typeof window !== 'undefined') compileWasm().catch(() => undefined)
  const evo = await import('@dashevo/evo-sdk')
  // In the browser build this is `wasm-shim.ts` (the prefetched module); in Node, evo-sdk's own.
  await evo.ensureInitialized()
  // A slow link may take minutes over the download; the connect itself gets a deadline, so a
  // hung quorum service fails (and is retried) instead of spinning forever. The deadline and
  // a cleanup both abort it, so an abandoned connect stops spending DAPI requests.
  const controller = new AbortController()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', () => controller.abort(), { once: true })
  const work = connectAndWarm(evo.EvoSDK, config, carry, controller.signal)
  // A connect that finishes after its deadline fired (or after a cleanup) has no taker.
  void work.then((c) => controller.signal.aborted && dispose(c), () => undefined)
  return withTimeout(work, CONNECT_TIMEOUT_MS, 'Connecting to Platform', controller)
}

/** Throw if the connect was abandoned during the last step, freeing the SDK it built. */
function step(signal: AbortSignal, sdk: EvoSDK | null): void {
  if (!signal.aborted) return
  if (sdk !== null) dispose({ sdk, seeded: new Map() })
  throw new Error('the connect was abandoned')
}

async function connectAndWarm(
  EvoSDKClass: typeof import('@dashevo/evo-sdk').EvoSDK,
  config: EvoSdkConfig,
  carry: Carry,
  signal: AbortSignal,
): Promise<Connection> {
  // `banFailedAddress: false`: a failed attempt only drops the node from the SDK's sticky
  // rotation and the next attempt goes to another node (rs-dapi-client
  // `update_address_ban_status`); nothing is banned, so a burst of refusals can no longer
  // leave the SDK with "no available addresses" (D-102, D-902). The trade-off: the SDK no
  // longer keeps a node that is really down out for minutes. The gate does that instead, for
  // `DOWN_MS`, from network errors, HTTP 5xx and gRPC `Unavailable`. It also turns off the
  // SDK's DPNS-registration owner failover, which this app does not use (it registers no names).
  //
  // No `version` option: evo-sdk passes it to `withVersion`, which PINS the version and turns
  // auto-detect off (rs-sdk `SdkBuilder::with_version`). wasm-sdk seeds the learned version on
  // its own (`protocol_version_store`), and the service's handle never reports lower.
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
  step(signal, sdk)
  // Seed the bundled contracts, then preload what is still missing, BEFORE the connection goes
  // live so callers never see an unwarmed SDK.
  const seeded = await seed(sdk, NETWORKS[config.network].key, carry.outdated)
  step(signal, sdk)
  await preload(sdk, config.contractIds.filter((id) => !seeded.has(id)))
  step(signal, sdk)
  return { sdk, seeded }
}

/** The process-wide evo-sdk service singleton. */
export const evoSdkService = new EvoSdkService()
// Every serialized write (documents, identity key updates) holds the connection.
setWriteHold((write) => evoSdkService.holdForWrite(write))

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
