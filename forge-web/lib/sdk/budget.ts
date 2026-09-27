/**
 * The DAPI request budget: a token bucket per DAPI node, shared by every tab of this browser
 * profile, and the rate-limit hold a node's gateway asks for.
 *
 * Why per node. Each masternode's gateway (Envoy with its own ratelimit service, dashmate
 * `platform/gateway/rate_limiter`) counts requests per client IP in fixed 60 s windows: 150
 * per window on moutai (`ratelimit-limit: 150`). The count is kept per node, so two nodes
 * answer the same client with different `ratelimit-remaining` in the same second. A bucket
 * per node is the model that matches what the network enforces.
 *
 * The bucket (GCRA form): {@link BURST} requests at once, then one per {@link INTERVAL_MS}.
 * No 60 s window can hold more than `BURST + 60 s / INTERVAL_MS` = 120 requests to one node,
 * which is well under the 150 the gateway allows and leaves room for a `dg` command or a runner
 * behind the same IP.
 *
 * Rate limits. A rate-limited reply (gRPC `ResourceExhausted` or HTTP 429, carrying
 * `ratelimit-reset`) becomes a hold on that node until the reset, plus jitter, and the request
 * is sent again to the same node. The SDK never sees the reply, so it never bans or evicts a
 * node for a rate limit (the SDK also runs with `banFailedAddress: false`, see `service.ts`).
 *
 * Every tab of the profile shares the budget: takes and holds are broadcast on a
 * `BroadcastChannel` and mirrored to `localStorage`, so a reload or a new tab starts from the
 * shared state instead of a full bucket.
 *
 * API (P-2 and P-3 build on this; keep it small):
 *  - {@link installDapiFetchGate}: routes every DAPI gRPC-web `fetch` the page makes (SDK
 *    queries, counts, broadcasts and waits, the inbox poller, the quorum cross-check, the
 *    Core-over-DAPI client) through the budget. Idempotent; call it before the first DAPI call.
 *  - {@link dapiBudget}: `acquire(node, signal?)` waits for a token, `hold(node, untilMs)` stops
 *    requests to a node until a time, and `status()` / `subscribe(fn)` report whether anything
 *    is waiting, until when, and why (the "Platform is busy" pill reads these).
 *
 * The gate sits at the transport because the SDK retries internally (5 times by default).
 * A wrapper around the SDK facades would not see those retries.
 */

import { sleep } from './facade'

/** Requests one node may take at once. */
export const BURST = 60
/** Sustained pace per node after the burst: one request per second. */
export const INTERVAL_MS = 1000
/** How many times one request waits out a rate limit before its reply goes back to the SDK. */
export const RATE_LIMIT_RETRIES = 5
/** Random extra wait after a reset, so tabs and requests do not all return in the same instant. */
export const RESET_JITTER_MS = 1000
/** Stop sending to a node when its gateway reports this few requests left in the window. */
export const LOW_WATER = 5
/** The longest reset honoured: the gateway's window is 60 s. */
const MAX_RESET_MS = 60_000

/** Burst tolerance of the GCRA bucket: `BURST - 1` intervals. */
const TOLERANCE_MS = (BURST - 1) * INTERVAL_MS

const STORAGE_KEY = 'forge.dapiBudget.v1'
const CHANNEL_NAME = 'forge-dapi-budget'

/** What is waiting on the budget right now. */
export interface BudgetStatus {
  /** Epoch ms when the longest current wait ends, or null when nothing waits. */
  readonly waitingUntil: number | null
  /** `rate-limit`: a node asked us to wait. `pacing`: our own bucket is empty. */
  readonly cause: 'rate-limit' | 'pacing' | null
}

export const IDLE: BudgetStatus = { waitingUntil: null, cause: null }

/** One node's state: GCRA theoretical arrival time and the rate-limit hold. */
interface NodeState {
  tat: number
  holdUntil: number
}

type BudgetMessage =
  | { readonly t: 'take'; readonly node: string; readonly at: number }
  | { readonly t: 'hold'; readonly node: string; readonly until: number }

/** The part of `BroadcastChannel` the budget uses (tests pass a fake). */
export interface BudgetChannel {
  postMessage(message: BudgetMessage): void
  addEventListener(type: 'message', listener: (event: { data: BudgetMessage }) => void): void
}

/** The part of `Storage` the budget uses. */
export interface BudgetStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface BudgetOptions {
  readonly channel?: BudgetChannel
  readonly storage?: BudgetStorage
}

export class RequestBudget {
  private readonly nodes = new Map<string, NodeState>()
  private readonly waits = new Map<symbol, { until: number; cause: 'rate-limit' | 'pacing' }>()
  private readonly listeners = new Set<() => void>()
  private current: BudgetStatus = IDLE
  private readonly channel: BudgetChannel | undefined
  private readonly storage: BudgetStorage | undefined

  constructor(options: BudgetOptions = {}) {
    this.channel = options.channel
    this.storage = options.storage
    this.restore()
    this.channel?.addEventListener('message', (event) => this.apply(event.data))
  }

  /**
   * Resolve when a request to `node` may go out, and take its token. Rejects with an
   * `AbortError` when `signal` aborts while it waits.
   */
  async acquire(node: string, signal?: AbortSignal): Promise<void> {
    const key = Symbol(node)
    try {
      for (;;) {
        const state = this.state(node)
        const now = Date.now()
        const held = state.holdUntil - now
        const paced = state.tat - TOLERANCE_MS - now
        const wait = Math.max(held, paced)
        if (wait <= 0) {
          this.take(node, now)
          this.persist()
          this.publish({ t: 'take', node, at: now })
          return
        }
        this.setWait(key, now + wait, held >= paced ? 'rate-limit' : 'pacing')
        await sleep(wait, signal)
      }
    } finally {
      this.clearWait(key)
    }
  }

  /** Send nothing to `node` before `untilMs`, in every tab of the profile. */
  hold(node: string, untilMs: number): void {
    if (!this.holdLocal(node, untilMs)) return
    this.persist()
    this.publish({ t: 'hold', node, until: untilMs })
  }

  /** What is waiting now. Returns the same object until the status changes. */
  readonly status = (): BudgetStatus => this.current

  /** Call `listener` whenever {@link status} changes. Returns the unsubscribe function. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private state(node: string): NodeState {
    let state = this.nodes.get(node)
    if (state === undefined) {
      state = { tat: 0, holdUntil: 0 }
      this.nodes.set(node, state)
    }
    return state
  }

  private take(node: string, at: number): void {
    const state = this.state(node)
    state.tat = Math.max(state.tat, at) + INTERVAL_MS
  }

  /** Extend the node's hold to `until`; false when it already lasts that long. */
  private holdLocal(node: string, until: number): boolean {
    const state = this.state(node)
    if (until <= state.holdUntil) return false
    state.holdUntil = until
    return true
  }

  /** A take or hold from another tab (that tab persists it). */
  private apply(message: BudgetMessage): void {
    if (message.t === 'take') this.take(message.node, message.at)
    else this.holdLocal(message.node, message.until)
  }

  private publish(message: BudgetMessage): void {
    try {
      this.channel?.postMessage(message)
    } catch {
      // A closed channel only loses cross-tab sharing; this tab's budget still holds.
    }
  }

  private persist(): void {
    if (this.storage === undefined) return
    const now = Date.now()
    const live: Record<string, NodeState> = {}
    for (const [node, state] of this.nodes) {
      if (state.tat > now || state.holdUntil > now) live[node] = state
    }
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(live))
    } catch {
      // Storage full or blocked: the in-memory budget still holds for this tab.
    }
  }

  private restore(): void {
    let saved: unknown
    try {
      saved = JSON.parse(this.storage?.getItem(STORAGE_KEY) ?? 'null')
    } catch {
      return
    }
    if (saved === null || typeof saved !== 'object') return
    for (const [node, value] of Object.entries(saved as Record<string, unknown>)) {
      const { tat, holdUntil } = (value ?? {}) as Partial<NodeState>
      if (typeof tat === 'number' && typeof holdUntil === 'number') this.nodes.set(node, { tat, holdUntil })
    }
  }

  private setWait(key: symbol, until: number, cause: 'rate-limit' | 'pacing'): void {
    this.waits.set(key, { until, cause })
    this.refresh()
  }

  private clearWait(key: symbol): void {
    if (this.waits.delete(key)) this.refresh()
  }

  private refresh(): void {
    let next: BudgetStatus = IDLE
    for (const { until, cause } of this.waits.values()) {
      // A node's rate limit is the more important thing to report; within a cause, the longest wait.
      const outranks =
        next.cause === null ||
        (cause === 'rate-limit' && next.cause === 'pacing') ||
        (cause === next.cause && until > (next.waitingUntil ?? 0))
      if (outranks) next = { waitingUntil: until, cause }
    }
    if (next.waitingUntil === this.current.waitingUntil && next.cause === this.current.cause) return
    this.current = next
    for (const listener of this.listeners) listener()
  }
}

// ---------------------------------------------------------------------------
// The fetch gate
// ---------------------------------------------------------------------------

/**
 * Path of every DAPI gRPC-web method (Platform and Core services). The SDK joins the node
 * address (`https://host:1443/`) and the method path (`/org.dash…`), so its paths start `//`.
 */
const DAPI_PATH = /^\/+org\.dash\.platform\.dapi\.v0\./

/** The DAPI node (URL origin) a request goes to, or null when it is not a DAPI call. */
export function dapiNodeOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return DAPI_PATH.test(parsed.pathname) ? parsed.origin : null
  } catch {
    return null
  }
}

function resetMs(response: Response): number | null {
  const seconds = Number(response.headers.get('ratelimit-reset'))
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RESET_MS) : null
}

/**
 * How long `response` asks the client to wait: a gateway rate-limit reply (gRPC
 * `ResourceExhausted`, sent as HTTP 200 with a `grpc-status: 8` header, or a bare HTTP 429)
 * that carries `ratelimit-reset`. Null for any other response.
 */
export function rateLimitWaitMs(response: Response): number | null {
  const limited = response.status === 429 || response.headers.get('grpc-status') === '8'
  return limited ? resetMs(response) : null
}

/** Until when the node that sent `response` should get nothing more, when its window is nearly spent. */
function lowWaterUntil(response: Response, now: number): number | null {
  const remaining = response.headers.get('ratelimit-remaining')
  if (remaining === null || Number(remaining) > LOW_WATER) return null
  const wait = resetMs(response)
  return wait === null ? null : now + wait
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

/**
 * `base` with every DAPI request routed through `budget`: each attempt waits for a token, and
 * a rate-limited reply holds the node and is retried on the same node after the reset (at most
 * {@link RATE_LIMIT_RETRIES} times; after that the reply goes back to the caller). Other
 * requests pass straight through.
 */
export function gatedFetch(base: typeof fetch, budget: RequestBudget): typeof fetch {
  return async (input, init) => {
    const node = dapiNodeOf(urlOf(input))
    if (node === null) return base(input, init)
    // A Request can be sent once. Each attempt sends a copy of this one with the body as
    // bytes: a cloned Request would carry a stream body, which the browser uploads differently
    // and devtools cannot show.
    const request = new Request(input, init)
    const body = request.body === null ? undefined : await request.arrayBuffer()
    for (let attempt = 0; ; attempt++) {
      await budget.acquire(node, request.signal)
      const response = await base(new Request(request, { body }))
      const now = Date.now()
      const wait = rateLimitWaitMs(response)
      if (wait === null) {
        const until = lowWaterUntil(response, now)
        if (until !== null) budget.hold(node, until)
        return response
      }
      budget.hold(node, now + wait + Math.floor(Math.random() * RESET_JITTER_MS))
      if (attempt >= RATE_LIMIT_RETRIES) return response
      await response.body?.cancel().catch(() => undefined)
    }
  }
}

// Browser only: Node has a global BroadcastChannel too, and an open one would keep the static
// build (which imports this module) from exiting.
const inBrowser = typeof window !== 'undefined'

function browserChannel(): BudgetChannel | undefined {
  if (!inBrowser || typeof BroadcastChannel === 'undefined') return undefined
  return new BroadcastChannel(CHANNEL_NAME) as unknown as BudgetChannel
}

function browserStorage(): BudgetStorage | undefined {
  try {
    return !inBrowser || typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    // Some browsers throw on access when site storage is blocked.
    return undefined
  }
}

/** The profile-wide DAPI budget of this page. */
export const dapiBudget = new RequestBudget({ channel: browserChannel(), storage: browserStorage() })

let installed = false

/** Route every DAPI `fetch` of this page through {@link dapiBudget}. Idempotent; browser only. */
export function installDapiFetchGate(): void {
  if (installed || !inBrowser || typeof globalThis.fetch !== 'function') return
  installed = true
  globalThis.fetch = gatedFetch(globalThis.fetch.bind(globalThis), dapiBudget)
}
