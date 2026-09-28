/**
 * The DAPI request budget: a token bucket per DAPI node, shared by every tab of this browser
 * profile, plus the rate-limit and down-node holds that steer requests to other nodes.
 *
 * Why per node. Each masternode's gateway (Envoy with its own ratelimit service, dashmate
 * `platform/gateway/rate_limiter`) counts requests per client IP in fixed 60 s windows: 150
 * per window on moutai (`ratelimit-limit: 150`). The count is kept per node: two nodes answer
 * the same client with different `ratelimit-remaining` in the same second.
 *
 * The bucket (GCRA form): {@link BURST} requests at once, then one per {@link INTERVAL_MS}.
 * No 60 s window holds more than `BURST + 60 s / INTERVAL_MS` = 120 requests to one node, well
 * under the 150 the gateway allows, leaving room for a `dg` command or a runner on the same IP.
 *
 * How a request is routed ({@link gatedFetch}):
 *  - The node is free: take a token and send.
 *  - The node is held or its bucket is empty for at most {@link SHORT_WAIT_MS}: wait, then send.
 *  - Longer, and another node is free: answer at once with a synthetic refusal (gRPC
 *    `ResourceExhausted`, or `Unavailable` for a down node). The SDK runs with
 *    `banFailedAddress: false`, so it only drops that node from its rotation and sends the
 *    request to the next one. The wasm transport has no client timeout, so waiting here would
 *    stall the SDK attempt for as long as the hold lasts.
 *  - Longer, but the IP looks busy everywhere ({@link FAILOVER_MAX_HELD} nodes held, e.g. a
 *    `dg` import runs next to the tab), or {@link FAILOVER_BURST} fail-overs were handed out
 *    in the last {@link FAILOVER_WINDOW_MS}, or no other node is known: wait for this node,
 *    within {@link CALL_DEADLINE_MS}. The "Platform is busy — waiting Ns" status shows that.
 *    The fail-over budget matters because every refusal handed back costs the SDK one of its
 *    few attempts (measured live: a read gives up after 4 refused attempts); spending them all
 *    ends the read with an error. A good reply does not restore it: other reads answer while
 *    one read is still spending its attempts. Two fail-overs a minute are enough, because the
 *    SDK takes a refused node out of its rotation and does not pick it again soon.
 *
 * A reply is a rate limit only when it is the gateway's over-limit reply: gRPC
 * `ResourceExhausted` with `ratelimit-remaining: 0` or `grpc-message: rate limited` (dashmate
 * envoy `local_reply_config`), or an HTTP 429, carrying `ratelimit-reset`. Envoy puts the
 * `ratelimit-*` headers on every reply, and `ResourceExhausted` also means a Drive size limit,
 * a full mempool or too many pending waits; none of those is a rate limit. The node is held
 * until the reset (plus jitter); a reset of {@link SHORT_RETRY_RESET_MS} or less is waited out
 * and retried on the same node, a longer one fails over.
 *
 * A node the browser could not reach (a network error, HTTP 5xx, gRPC `Unavailable`) is kept
 * out of rotation for {@link DOWN_MS}. With banning off this is the only down-node tracking.
 *
 * Takes and rate-limit holds are broadcast on a `BroadcastChannel` and mirrored to
 * `localStorage`, so every tab and a reloaded page share one budget.
 *
 * API for P-2, P-3 and the rest (keep it small):
 *  - {@link installDapiFetchGate}: route every DAPI gRPC-web `fetch` of the page through the
 *    budget. Idempotent. The app calls it at start (`providers.tsx`, `service.ts`).
 *  - {@link dapiBudget}: `status()` / `subscribe(fn)` report what is waiting, until when and
 *    why; `hold(node, untilMs)` holds a node, for a caller that learns of a limit elsewhere;
 *    `retryAfterMs()` says how long until most nodes are free again (for reconnect logic).
 *
 * Never wrap SDK calls in a budget wait of your own: the SDK retries internally and each
 * attempt already passes the gate. Issue the reads; the gate paces them.
 */

/** Requests one node may take at once. */
export const BURST = 60
/** Sustained pace per node after the burst: one request per second. */
export const INTERVAL_MS = 1000
/** A wait up to this long is sat out on the chosen node; a longer one fails over. */
export const SHORT_WAIT_MS = 2000
/** A rate limit that resets within this is retried on the same node. */
export const SHORT_RETRY_RESET_MS = 1000
/** With this many nodes held, the IP is busy everywhere: wait instead of failing over. */
export const FAILOVER_MAX_HELD = 3
/** At most this many fail-overs per {@link FAILOVER_WINDOW_MS}; then wait instead. */
export const FAILOVER_BURST = 2
export const FAILOVER_WINDOW_MS = 60_000
/** The longest one gated call waits in total before it answers with a refusal. */
export const CALL_DEADLINE_MS = 70_000
/** Stop sending to a node when its gateway reports this few requests left in the window. */
export const LOW_WATER = 5
/** Random extra hold after a reset, so tabs do not all come back in the same instant. */
export const RESET_JITTER_MS = 1000
/** Random extra wait per waiter, so held requests do not all go out at once. */
export const WAITER_JITTER_MS = 250
/** How long an unreachable node stays out of rotation. */
export const DOWN_MS = 15_000
/**
 * A document read not answering within this long is also sent to another free node, and the
 * first good answer is used (L-15). A read answers in 60–400 ms; the slow tail seen live was
 * one node taking 4–15 s while the others were idle, and the SDK only retries elsewhere after
 * its own 15 s timeout. Every answer is proof-checked by the SDK, so which node served it
 * does not matter.
 */
export const HEDGE_AFTER_MS = 2000
/** Hedges in flight at once, so a slow network cannot double the load. */
export const HEDGE_MAX_IN_FLIGHT = 2
/** Hedges as a share of this tab's gated requests over {@link FAILOVER_WINDOW_MS} (at least one). */
export const HEDGE_SHARE = 0.1
/**
 * Once the node's own reply came back unusable (a rate limit, an unavailable node) while the
 * hedge is still out, how long the hedge gets before that reply is passed on, so the SDK's
 * fail-over is not held up by a hedge that is slow too.
 */
export const HEDGE_GRACE_MS = 500

/** The gateway's window: no reset is longer. */
const MAX_RESET_MS = 60_000
/** No hold reaches further ahead than the longest reset plus its jitter. */
const MAX_HOLD_AHEAD_MS = MAX_RESET_MS + RESET_JITTER_MS
/** Burst tolerance of the GCRA bucket: `BURST - 1` intervals. */
const TOLERANCE_MS = (BURST - 1) * INTERVAL_MS
/** No bucket queues more than a window beyond its burst. */
const MAX_TAT_AHEAD_MS = TOLERANCE_MS + MAX_RESET_MS

const STORAGE_KEY = 'forge.dapiBudget.v1'
const CHANNEL_NAME = 'forge-dapi-budget'

/** What is waiting on the budget right now. */
export interface BudgetStatus {
  /** Epoch ms when the longest current wait ends, or null when nothing waits. */
  readonly waitingUntil: number | null
  /** `rate-limit`: nodes asked us to wait. `pacing`: our own bucket is empty. */
  readonly cause: 'rate-limit' | 'pacing' | null
}

export const IDLE: BudgetStatus = { waitingUntil: null, cause: null }

/** The budget as the rest of the app uses it. */
export interface DapiBudget {
  /** Send nothing to `node` (a URL origin) before `untilMs`, in every tab of the profile. */
  hold(node: string, untilMs: number): void
  /** What is waiting now; the same object until it changes. */
  status(): BudgetStatus
  /** Call `listener` whenever {@link status} changes. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /**
   * How long until at least half of the known nodes are free of rate-limit holds; 0 when they
   * already are. For callers that would otherwise hit busy nodes again (e.g. a reconnect after
   * "no available addresses": wait this long first).
   */
  retryAfterMs(): number
}

/** One node's state: GCRA theoretical arrival time, rate-limit hold, and down-until. */
interface NodeState {
  tat: number
  holdUntil: number
  downUntil: number
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

/** How long to wait before a request may go to a node, and why. */
interface Wait {
  readonly ms: number
  readonly cause: 'rate-limit' | 'pacing'
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

/** A sleep that rejects with the signal's reason when it aborts. */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const reason = (): unknown => signal?.reason ?? new DOMException('cancelled', 'AbortError')
    if (signal?.aborted) {
      reject(reason())
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(reason())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class RequestBudget implements DapiBudget {
  private readonly nodes = new Map<string, NodeState>()
  private readonly known = new Set<string>()
  private readonly waits = new Map<symbol, { until: number; cause: 'rate-limit' | 'pacing' }>()
  private readonly listeners = new Set<() => void>()
  /** When this tab handed out fail-overs (refusals the caller retries elsewhere). */
  private failovers: number[] = []
  private current: BudgetStatus = IDLE
  private readonly channel: BudgetChannel | undefined
  private readonly storage: BudgetStorage | undefined

  constructor(options: BudgetOptions = {}) {
    this.channel = options.channel
    this.storage = options.storage
    this.restore()
    this.channel?.addEventListener('message', (event) => this.apply(event.data))
  }

  hold(node: string, untilMs: number): void {
    if (!this.holdLocal(node, untilMs)) return
    this.persist()
    this.publish({ t: 'hold', node, until: this.state(node).holdUntil })
  }

  readonly status = (): BudgetStatus => this.current

  readonly retryAfterMs = (now = Date.now()): number => {
    const holds = [...new Set([...this.known, ...this.nodes.keys()])]
      .map((node) => Math.max(0, this.state(node, now).holdUntil - now))
      .sort((a, b) => a - b)
    if (holds.length === 0) return 0
    return holds[Math.floor((holds.length - 1) / 2)] ?? 0
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ---- internal: used by the gate and the tests, not by app code -------------------------

  /** @internal The DAPI nodes of the network, so a node without traffic yet counts as free. */
  addNodes(nodes: readonly string[]): void {
    for (const node of nodes) this.known.add(node)
  }

  /** @internal How long before a request may go to `node`; 0 when it may go now. */
  waitFor(node: string, now = Date.now()): Wait {
    const state = this.state(node, now)
    const held = state.holdUntil - now
    const paced = state.tat - TOLERANCE_MS - now
    return { ms: Math.max(0, held, paced), cause: held >= paced ? 'rate-limit' : 'pacing' }
  }

  /** @internal Whether `node` failed to answer recently. */
  isDown(node: string, now = Date.now()): boolean {
    return this.state(node, now).downUntil > now
  }

  /** @internal Keep `node` out of rotation until `untilMs` (this tab only). */
  markDown(node: string, untilMs: number): void {
    const state = this.state(node)
    state.downUntil = Math.max(state.downUntil, Math.min(untilMs, Date.now() + DOWN_MS))
  }

  /**
   * @internal Whether a request that cannot go to `node` soon should go to another node: some
   * other node is free (up, and within {@link SHORT_WAIT_MS}), fewer than
   * {@link FAILOVER_MAX_HELD} nodes are rate-limited, and the fail-over budget is not spent.
   */
  shouldFailOver(node: string, now = Date.now()): boolean {
    this.failovers = this.failovers.filter((t) => t > now - FAILOVER_WINDOW_MS && t <= now)
    if (this.failovers.length >= FAILOVER_BURST) return false
    let held = 0
    let free = false
    for (const other of new Set([...this.known, ...this.nodes.keys()])) {
      const state = this.state(other, now)
      if (state.holdUntil > now) held++
      if (other !== node && state.downUntil <= now && this.waitFor(other, now).ms <= SHORT_WAIT_MS) free = true
    }
    return free && held < FAILOVER_MAX_HELD
  }

  /** @internal A node other than `node` that is up and may take a request now (random among them), or null. */
  freeNode(node: string, now = Date.now()): string | null {
    const free = [...new Set([...this.known, ...this.nodes.keys()])].filter(
      (other) => other !== node && this.state(other, now).downUntil <= now && this.waitFor(other, now).ms === 0,
    )
    return free[Math.floor(Math.random() * free.length)] ?? null
  }

  /** When this tab sent gated requests, and hedges, in the last {@link FAILOVER_WINDOW_MS}. */
  private sent: number[] = []
  private hedges: number[] = []
  private hedgesInFlight = 0

  /** @internal Count one gated request sent (the base of the hedge share). */
  noteSent(now = Date.now()): void {
    this.sent.push(now)
  }

  /**
   * @internal A node to hedge a slow read to, taking one hedge from the budget, or null: at most
   * {@link HEDGE_MAX_IN_FLIGHT} at once, about {@link HEDGE_SHARE} of the requests sent in the
   * window, and none while {@link FAILOVER_MAX_HELD} or more nodes are held or down (a busy or
   * failing network is not helped by more requests). Pair with {@link hedgeDone}.
   */
  startHedge(node: string, now = Date.now()): string | null {
    const since = now - FAILOVER_WINDOW_MS
    this.sent = this.sent.filter((t) => t > since && t <= now)
    this.hedges = this.hedges.filter((t) => t > since && t <= now)
    if (this.hedgesInFlight >= HEDGE_MAX_IN_FLIGHT) return null
    if (this.hedges.length >= Math.max(1, Math.floor(this.sent.length * HEDGE_SHARE))) return null
    let impaired = 0
    for (const n of new Set([...this.known, ...this.nodes.keys()])) {
      const state = this.state(n, now)
      if (state.holdUntil > now || state.downUntil > now) impaired++
    }
    if (impaired >= FAILOVER_MAX_HELD) return null
    const other = this.freeNode(node, now)
    if (other === null) return null
    this.hedges.push(now)
    this.hedgesInFlight++
    this.take(other, now)
    return other
  }

  /** @internal A hedge from {@link startHedge} settled. */
  hedgeDone(): void {
    this.hedgesInFlight = Math.max(0, this.hedgesInFlight - 1)
  }

  /** @internal Record a fail-over handed to the caller. */
  failedOver(now = Date.now()): void {
    this.failovers.push(now)
  }

  /** @internal Take `node`'s token for a request sent at `at`. */
  take(node: string, at = Date.now()): void {
    this.takeLocal(node, at)
    this.persist()
    this.publish({ t: 'take', node, at })
  }

  /** @internal Wait until `until` (plus per-waiter jitter), reported in {@link status}. */
  async wait(until: number, cause: 'rate-limit' | 'pacing', signal?: AbortSignal | null): Promise<void> {
    const key = Symbol('wait')
    this.waits.set(key, { until, cause })
    this.refresh()
    try {
      const ms = Math.min(Math.max(0, until - Date.now()), MAX_HOLD_AHEAD_MS)
      await sleep(ms + Math.floor(Math.random() * WAITER_JITTER_MS), signal)
    } finally {
      this.waits.delete(key)
      this.refresh()
    }
  }

  /** A node's state, with anything further ahead than a clock jump could explain cut back. */
  private state(node: string, now = Date.now()): NodeState {
    let state = this.nodes.get(node)
    if (state === undefined) {
      state = { tat: 0, holdUntil: 0, downUntil: 0 }
      this.nodes.set(node, state)
    }
    state.tat = Math.min(state.tat, now + MAX_TAT_AHEAD_MS)
    state.holdUntil = Math.min(state.holdUntil, now + MAX_HOLD_AHEAD_MS)
    state.downUntil = Math.min(state.downUntil, now + DOWN_MS)
    return state
  }

  private takeLocal(node: string, at: number): void {
    if (!finite(at)) return
    const now = Date.now()
    const state = this.state(node, now)
    state.tat = Math.min(Math.max(state.tat, Math.min(at, now)) + INTERVAL_MS, now + MAX_TAT_AHEAD_MS)
  }

  /** Extend the node's hold to `until` (clamped); false when it already lasts that long. */
  private holdLocal(node: string, until: number): boolean {
    if (!finite(until)) return false
    const now = Date.now()
    const state = this.state(node, now)
    const clamped = Math.min(until, now + MAX_HOLD_AHEAD_MS)
    if (clamped <= state.holdUntil) return false
    state.holdUntil = clamped
    return true
  }

  /** A take or hold from another tab (that tab persists it). */
  private apply(message: BudgetMessage): void {
    if (message?.t === 'take') this.takeLocal(message.node, message.at)
    else if (message?.t === 'hold') this.holdLocal(message.node, message.until)
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
    const live: Record<string, { tat: number; holdUntil: number }> = {}
    for (const [node, { tat, holdUntil }] of this.nodes) {
      if (tat > now || holdUntil > now) live[node] = { tat, holdUntil }
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
      if (!finite(tat) || !finite(holdUntil)) continue
      const state = this.state(node)
      state.tat = tat
      state.holdUntil = holdUntil
      this.state(node) // clamp what was read
    }
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
 * How long `response` asks the client to wait, when it is the gateway's over-limit reply:
 * gRPC `ResourceExhausted` (HTTP 200 + `grpc-status: 8`) with `ratelimit-remaining: 0` or
 * `grpc-message: rate limited`, or an HTTP 429, carrying `ratelimit-reset`. Null otherwise:
 * other `ResourceExhausted` replies (size limits, a full mempool) are not rate limits.
 */
export function rateLimitWaitMs(response: Response): number | null {
  const headers = response.headers
  const overLimit =
    response.status === 429 ||
    (headers.get('grpc-status') === '8' &&
      (headers.get('ratelimit-remaining') === '0' || headers.get('grpc-message') === 'rate limited'))
  return overLimit ? resetMs(response) : null
}

/** Whether `response` says the node could not serve (HTTP 5xx or gRPC `Unavailable`). */
function nodeUnavailable(response: Response): boolean {
  return response.status >= 500 || response.headers.get('grpc-status') === '14'
}

/** Until when the node that sent `response` should get nothing more, when its window is nearly spent. */
function lowWaterUntil(response: Response, now: number): number | null {
  const remaining = response.headers.get('ratelimit-remaining')
  if (remaining === null || Number(remaining) > LOW_WATER) return null
  const wait = resetMs(response)
  return wait === null ? null : now + wait + Math.floor(Math.random() * RESET_JITTER_MS)
}

/**
 * A gRPC-web error reply made here, never sent: tells the caller to try another node. The SDK
 * (with banning off) and the hand-written DAPI clients move on to the next node on either code.
 */
function refusal(code: 8 | 14, message: string): Response {
  return new Response(new Uint8Array(0), {
    status: 200,
    headers: { 'content-type': 'application/grpc-web+proto', 'grpc-status': String(code), 'grpc-message': message },
  })
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

/** The reads {@link sendHedged} may send twice: proof-verified document queries (idempotent). */
const HEDGED_PATH = /\/org\.dash\.platform\.dapi\.v0\.Platform\/getDocuments$/

/** A reply the caller can use as is: not a rate limit, not an unavailable node. */
function usable(response: Response): boolean {
  return !nodeUnavailable(response) && rateLimitWaitMs(response) === null
}

interface Outcome {
  readonly from: string
  readonly response?: Response
  readonly error?: unknown
}

/** A reply and the node it came from. */
interface Answer {
  readonly response: Response
  readonly from: string
}

function unwrap(o: Outcome): Answer {
  if (o.response === undefined) throw o.error
  return { response: o.response, from: o.from }
}

/** Book an unusable reply (or a failure) against the node that sent it, like the gate does. */
function book(budget: RequestBudget, o: Outcome): void {
  const now = Date.now()
  const limit = o.response === undefined ? null : rateLimitWaitMs(o.response)
  if (limit !== null) budget.hold(o.from, now + limit + Math.floor(Math.random() * RESET_JITTER_MS))
  else if (o.response === undefined ? !isAbort(o.error) : nodeUnavailable(o.response)) budget.markDown(o.from, now + DOWN_MS)
}

function delay<T>(ms: number, value: T): { readonly promise: Promise<T>; readonly cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(value), ms)
  })
  return { promise, cancel: () => clearTimeout(timer) }
}

/**
 * Send `request` to `node`. A document read with no answer after {@link HEDGE_AFTER_MS} also goes
 * to one other free node, within the hedge budget ({@link RequestBudget.startHedge}), and the
 * first usable answer wins (the other is aborted). Resolves with that answer and the node it came
 * from. When neither is usable, `node`'s own answer (or error) is what the caller gets, so its
 * rate-limit and down-node handling sees what that node said. Once a hedge is out, whichever reply
 * is not passed back is booked here.
 *
 * Every request carries the caller's signal, so an abort reaches it for as long as it runs,
 * streamed replies included. A non-hedged request is sent exactly as the gate sent it before.
 */
async function sendHedged(
  base: typeof fetch,
  budget: RequestBudget,
  request: Request,
  body: ArrayBuffer | undefined,
  node: string,
): Promise<Answer> {
  const url = new URL(request.url)
  if (!HEDGED_PATH.test(url.pathname)) return { response: await base(new Request(request, { body })), from: node }

  const send = (to: string): { readonly outcome: Promise<Outcome>; readonly controller: AbortController } => {
    const controller = new AbortController()
    const signal = AbortSignal.any([request.signal, controller.signal])
    const sent =
      to === node
        ? new Request(request, { body, signal })
        : new Request(`${to}${url.pathname}${url.search}`, {
            method: request.method,
            headers: request.headers,
            mode: request.mode,
            credentials: request.credentials,
            body,
            signal,
          })
    const outcome = base(sent).then(
      (response): Outcome => ({ from: to, response }),
      (error: unknown): Outcome => ({ from: to, error }),
    )
    return { outcome, controller }
  }

  const own = send(node)
  const slow = delay(HEDGE_AFTER_MS, null)
  const early = await Promise.race([own.outcome, slow.promise])
  slow.cancel()
  if (early !== null || request.signal.aborted) return unwrap(early ?? (await own.outcome))
  const other = budget.startHedge(node)
  if (other === null) return unwrap(await own.outcome)
  const hedge = send(other)
  void hedge.outcome.finally(() => budget.hedgeDone())

  const isUsable = (o: Outcome): boolean => o.response !== undefined && usable(o.response)
  // The reply that is not passed back: book it (unless it was cancelled) and drop its body.
  const discard = (sent: typeof own, o: Outcome): void => {
    if (!sent.controller.signal.aborted && !request.signal.aborted) book(budget, o)
    void o.response?.body?.cancel().catch(() => undefined)
  }
  const first = await Promise.race([own.outcome, hedge.outcome])
  if (isUsable(first)) {
    const loser = first.from === node ? hedge : own
    loser.controller.abort()
    void loser.outcome.then((o) => discard(loser, o))
    return unwrap(first)
  }
  if (first.from !== node) {
    // The hedge could not serve: book it now and wait for the node's own reply.
    discard(hedge, first)
    return unwrap(await own.outcome)
  }
  // The node's own reply is unusable: the hedge gets a short grace, then the node's reply goes
  // back so the SDK fails over at once.
  const grace = delay(HEDGE_GRACE_MS, null)
  const second = await Promise.race([hedge.outcome, grace.promise])
  grace.cancel()
  if (second !== null && isUsable(second)) {
    discard(own, first)
    return unwrap(second)
  }
  if (second !== null) discard(hedge, second)
  else {
    // Still out after the grace: cancel it (a cancelled request is not booked).
    hedge.controller.abort()
    void hedge.outcome.then((o) => discard(hedge, o))
  }
  return unwrap(first)
}

/**
 * `base` with every DAPI request routed through `budget` (see the module comment for the
 * rules). Other requests pass straight through.
 */
export function gatedFetch(base: typeof fetch, budget: RequestBudget): typeof fetch {
  return async (input, init) => {
    const node = dapiNodeOf(urlOf(input))
    if (node === null) return base(input, init)
    // A Request can be sent once. Each attempt sends a copy with the body as bytes: a cloned
    // Request would carry a stream body, which the browser uploads differently.
    const request = new Request(input, init)
    const body = request.body === null ? undefined : await request.arrayBuffer()
    const deadline = Date.now() + CALL_DEADLINE_MS
    for (;;) {
      const now = Date.now()
      if (budget.isDown(node, now) && budget.shouldFailOver(node, now)) {
        budget.failedOver(now)
        return refusal(14, 'node unreachable a moment ago')
      }
      const wait = budget.waitFor(node, now)
      if (wait.ms > 0) {
        if (wait.ms > SHORT_WAIT_MS && budget.shouldFailOver(node, now)) {
          budget.failedOver(now)
          return refusal(8, 'rate limited')
        }
        if (now + wait.ms > deadline) return refusal(8, 'rate limited')
        await budget.wait(now + wait.ms, wait.cause, request.signal)
        continue
      }
      budget.take(node, now)
      budget.noteSent(now)
      let response: Response
      let from: string
      try {
        ;({ response, from } = await sendHedged(base, budget, request, body, node))
      } catch (e) {
        if (!request.signal.aborted && !isAbort(e)) budget.markDown(node, Date.now() + DOWN_MS)
        throw e
      }
      const after = Date.now()
      if (nodeUnavailable(response)) budget.markDown(node, after + DOWN_MS)
      const limit = rateLimitWaitMs(response)
      if (limit === null) {
        // The node that answered: a hedge's reply reports that node's window.
        const until = lowWaterUntil(response, after)
        if (until !== null) budget.hold(from, until)
        return response
      }
      budget.hold(node, after + limit + Math.floor(Math.random() * RESET_JITTER_MS))
      // A long reset fails over: the SDK sends the next attempt to another node. When it
      // cannot (every node busy), the loop waits for this node instead.
      if (limit > SHORT_RETRY_RESET_MS && budget.shouldFailOver(node, after)) {
        budget.failedOver(after)
        return response
      }
      if (after + limit > deadline) return response
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

const budget = new RequestBudget({ channel: browserChannel(), storage: browserStorage() })

/** The profile-wide DAPI budget of this page. */
export const dapiBudget: DapiBudget = budget

/** Marks the page's `fetch` as gated; survives module reloads (HMR), unlike a module flag. */
const GATED = Symbol.for('forge.dapiFetchGate')

/**
 * Route every DAPI `fetch` of this page through {@link dapiBudget}. `nodes` are the network's
 * configured DAPI addresses, so nodes without traffic yet count as free for failover.
 * Idempotent; browser only.
 */
export function installDapiFetchGate(nodes: readonly string[] = []): void {
  budget.addNodes(nodes.map((n) => dapiNodeOf(`${n.replace(/\/+$/, '')}/org.dash.platform.dapi.v0.`)).filter((n): n is string => n !== null))
  const scope = globalThis as typeof globalThis & { [GATED]?: true }
  if (!inBrowser || scope[GATED] || typeof scope.fetch !== 'function') return
  scope[GATED] = true
  scope.fetch = gatedFetch(scope.fetch.bind(scope), budget)
}
