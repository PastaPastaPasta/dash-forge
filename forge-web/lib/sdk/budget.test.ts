import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BURST,
  CALL_DEADLINE_MS,
  DOWN_MS,
  INTERVAL_MS,
  LOW_WATER,
  RequestBudget,
  SHORT_WAIT_MS,
  dapiNodeOf,
  gatedFetch,
  rateLimitWaitMs,
  type BudgetChannel,
  type BudgetStorage,
} from './budget'

const NODE = 'https://68.67.122.254:1443'
const OTHER = 'https://68.67.122.207:1443'
const THIRD = 'https://68.67.122.192:1443'
const FOURTH = 'https://68.67.122.194:1443'
/** What the SDK sends: the node address keeps its trailing slash. */
const METHOD = `${NODE}//org.dash.platform.dapi.v0.Platform/getDocuments`

/** In-memory BroadcastChannels: what one posts, the others receive. */
function channelHub(): () => BudgetChannel {
  const members: { listeners: ((e: { data: never }) => void)[] }[] = []
  return () => {
    const self = { listeners: [] as ((e: { data: never }) => void)[] }
    members.push(self)
    return {
      postMessage(message) {
        for (const m of members) if (m !== self) for (const l of m.listeners) l({ data: message as never })
      },
      addEventListener(_type, listener) {
        self.listeners.push(listener as (e: { data: never }) => void)
      },
    }
  }
}

function memoryStorage(initial?: string): BudgetStorage {
  const map = new Map<string, string>()
  if (initial !== undefined) map.set('forge.dapiBudget.v1', initial)
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

/** Resolves true when `p` settles within the current fake-timer step. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false
  p.then(
    () => (done = true),
    () => (done = true),
  )
  await vi.advanceTimersByTimeAsync(0)
  return done
}

function grpcReply(headers: Record<string, string>, status = 200): Response {
  return new Response(null, { status, headers: { 'content-type': 'application/grpc-web+proto', ...headers } })
}

/** The gateway's over-limit reply to a grpc-web client (dashmate envoy `local_reply_config`). */
function overLimit(resetS: number): Response {
  return grpcReply({
    'grpc-status': '8',
    'grpc-message': 'rate limited',
    'ratelimit-limit': '150',
    'ratelimit-remaining': '0',
    'ratelimit-reset': String(resetS),
  })
}

/** An ordinary reply: envoy puts the ratelimit headers on every reply. */
function ok(remaining = 120, resetS = 40): Response {
  return grpcReply({ 'grpc-status': '0', 'ratelimit-limit': '150', 'ratelimit-remaining': String(remaining), 'ratelimit-reset': String(resetS) })
}

/** Take `node`'s whole burst, so its next request would wait. */
function drain(budget: RequestBudget, node: string): void {
  for (let i = 0; i < BURST; i++) budget.take(node)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('RequestBudget', () => {
  it('lets a burst through, then paces one request per interval', () => {
    const budget = new RequestBudget()
    for (let i = 0; i < BURST; i++) {
      expect(budget.waitFor(NODE).ms).toBe(0)
      budget.take(NODE)
    }
    expect(budget.waitFor(NODE)).toEqual({ ms: INTERVAL_MS, cause: 'pacing' })
  })

  it('never allows more than 120 requests to one node in any 60 s window', async () => {
    const budget = new RequestBudget()
    const gated = gatedFetch((async () => ok()) as unknown as typeof fetch, budget)
    const sent: number[] = []
    const loop = (async () => {
      for (let i = 0; i < 400; i++) {
        await gated(METHOD, { method: 'POST' })
        sent.push(Date.now())
      }
    })()
    await vi.advanceTimersByTimeAsync(400 * (INTERVAL_MS + 250))
    await loop
    let worst = 0
    for (let i = 0; i < sent.length; i++) {
      const start = sent[i] as number
      let n = 0
      for (let j = i; j < sent.length && (sent[j] as number) < start + 60_000; j++) n++
      worst = Math.max(worst, n)
    }
    expect(worst).toBeLessThanOrEqual(120)
    expect(worst).toBeGreaterThan(90)
  })

  it('keeps a separate bucket per node', () => {
    const budget = new RequestBudget()
    drain(budget, NODE)
    expect(budget.waitFor(OTHER).ms).toBe(0)
  })

  it('reports a rate-limit wait while one is sat out', async () => {
    const budget = new RequestBudget()
    const seen: (string | null)[] = []
    budget.subscribe(() => seen.push(budget.status().cause))
    const waiting = budget.wait(Date.now() + 5000, 'rate-limit')
    expect(await settled(waiting)).toBe(false)
    expect(budget.status()).toEqual({ waitingUntil: 1_005_000, cause: 'rate-limit' })
    await vi.advanceTimersByTimeAsync(5300)
    expect(await settled(waiting)).toBe(true)
    expect(seen).toEqual(['rate-limit', null])
  })

  it('rejects a wait with the signal reason when it aborts', async () => {
    const budget = new RequestBudget()
    const controller = new AbortController()
    const waiting = budget.wait(Date.now() + 60_000, 'rate-limit', controller.signal).catch((e: unknown) => e)
    const reason = new Error('left the page')
    controller.abort(reason)
    expect(await waiting).toBe(reason)
    expect(budget.status().cause).toBeNull()
  })

  it('shares takes and holds across tabs', () => {
    const hub = channelHub()
    const a = new RequestBudget({ channel: hub() })
    const b = new RequestBudget({ channel: hub() })
    drain(a, NODE)
    expect(b.waitFor(NODE).ms).toBeGreaterThan(0)
    a.hold(OTHER, Date.now() + 3000)
    expect(b.waitFor(OTHER)).toEqual({ ms: 3000, cause: 'rate-limit' })
  })

  it('reports how long until most nodes are free of rate-limit holds', () => {
    const budget = new RequestBudget()
    budget.addNodes([NODE, OTHER, THIRD, FOURTH])
    expect(budget.retryAfterMs()).toBe(0)
    budget.hold(NODE, Date.now() + 30_000)
    expect(budget.retryAfterMs()).toBe(0)
    budget.hold(OTHER, Date.now() + 10_000)
    budget.hold(THIRD, Date.now() + 20_000)
    expect(budget.retryAfterMs()).toBe(10_000)
  })

  it('restores the shared state in a new tab from storage', () => {
    const storage = memoryStorage()
    new RequestBudget({ storage }).hold(NODE, Date.now() + 10_000)
    expect(new RequestBudget({ storage }).waitFor(NODE)).toEqual({ ms: 10_000, cause: 'rate-limit' })
  })

  // M1: a clock jump, a bad value from another tab or a hostile storage entry must not wedge a
  // node or produce a timer delay the browser cannot represent.
  it('clamps holds and bucket times that reach implausibly far ahead', () => {
    const hub = channelHub()
    const far = Date.now() + 10 * 365 * 24 * 3600_000
    const storage = memoryStorage(JSON.stringify({ [NODE]: { tat: far, holdUntil: far } }))
    const budget = new RequestBudget({ storage, channel: hub() })
    expect(budget.waitFor(NODE).ms).toBeLessThanOrEqual(120_000)
    budget.hold(OTHER, far)
    expect(budget.waitFor(OTHER).ms).toBeLessThanOrEqual(61_000)
    const peer = hub()
    peer.postMessage({ t: 'hold', node: THIRD, until: far })
    peer.postMessage({ t: 'take', node: FOURTH, at: far })
    peer.postMessage({ t: 'hold', node: FOURTH, until: Number.NaN })
    expect(budget.waitFor(THIRD).ms).toBeLessThanOrEqual(61_000)
    expect(budget.waitFor(FOURTH).ms).toBe(0)
  })
})

describe('rate-limit replies', () => {
  it('reads the gateway over-limit reply and a bare 429', () => {
    expect(rateLimitWaitMs(overLimit(9))).toBe(9000)
    expect(rateLimitWaitMs(grpcReply({ 'ratelimit-reset': '4' }, 429))).toBe(4000)
    expect(rateLimitWaitMs(overLimit(600))).toBe(60_000)
    expect(rateLimitWaitMs(grpcReply({ 'grpc-status': '8', 'grpc-message': 'rate limited', 'ratelimit-reset': '3' }))).toBe(3000)
  })

  // H2: envoy puts ratelimit-* on every reply, and ResourceExhausted also means Drive size
  // limits, a full mempool or too many pending waits.
  it('does not take another ResourceExhausted, or an ordinary reply, for a rate limit', () => {
    expect(rateLimitWaitMs(ok(40, 9))).toBeNull()
    expect(
      rateLimitWaitMs(grpcReply({ 'grpc-status': '8', 'grpc-message': 'too many pending waits', 'ratelimit-remaining': '97', 'ratelimit-reset': '12' })),
    ).toBeNull()
    expect(rateLimitWaitMs(grpcReply({ 'grpc-status': '8' }))).toBeNull()
    expect(rateLimitWaitMs(grpcReply({ 'grpc-status': '8', 'ratelimit-remaining': '0' }))).toBeNull()
  })

  it('recognises DAPI calls by path', () => {
    expect(dapiNodeOf(METHOD)).toBe(NODE)
    expect(dapiNodeOf(`${NODE}/org.dash.platform.dapi.v0.Core/getTransaction`)).toBe(NODE)
    expect(dapiNodeOf('https://quorums.moutai.networks.dash.org/quorums')).toBeNull()
    expect(dapiNodeOf('/_next/static/chunk.js')).toBeNull()
  })
})

describe('gatedFetch', () => {
  function withNodes(): RequestBudget {
    const budget = new RequestBudget()
    budget.addNodes([NODE, OTHER, THIRD, FOURTH])
    return budget
  }

  // H1: a long reset fails over at once instead of stalling the attempt (the wasm transport
  // has no client timeout).
  it('answers a long rate limit at once, so the caller moves to another node', async () => {
    const budget = withNodes()
    const base = vi.fn(async () => overLimit(30))
    const gated = gatedFetch(base as unknown as typeof fetch, budget)
    const pending = gated(METHOD, { method: 'POST' })
    expect(await settled(pending)).toBe(true)
    expect((await pending).headers.get('grpc-status')).toBe('8')
    expect(base).toHaveBeenCalledTimes(1)
    expect(budget.waitFor(NODE).ms).toBeGreaterThanOrEqual(30_000)
  })

  // Each refusal handed back costs the SDK one of its ~5 retries: a run of refusals must turn
  // into a wait, or the read ends in an error (seen live with six refusals in a row).
  it('stops failing over after a burst and waits for the node instead', async () => {
    const budget = withNodes()
    let calls = 0
    const base = vi.fn(async () => (++calls <= 3 ? overLimit(5) : ok()))
    const gated = gatedFetch(base as unknown as typeof fetch, budget)
    // The SDK's attempts, one node after another.
    expect((await gated(METHOD, { method: 'POST' })).headers.get('grpc-status')).toBe('8')
    expect((await gated(`${OTHER}//org.dash.platform.dapi.v0.Platform/getDocuments`, { method: 'POST' })).headers.get('grpc-status')).toBe('8')
    const third = gated(`${THIRD}//org.dash.platform.dapi.v0.Platform/getDocuments`, { method: 'POST' })
    expect(await settled(third)).toBe(false)
    expect(budget.status().cause).toBe('rate-limit')
    await vi.advanceTimersByTimeAsync(7000)
    expect((await third).headers.get('grpc-status')).toBe('0')
    // A good reply does not restore the budget (another read may still be spending its
    // attempts); the window does.
    base.mockImplementationOnce(async () => overLimit(5))
    const fourth = gated(`${FOURTH}//org.dash.platform.dapi.v0.Platform/getDocuments`, { method: 'POST' })
    expect(await settled(fourth)).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    base.mockImplementationOnce(async () => overLimit(5))
    expect((await gated(METHOD, { method: 'POST' })).headers.get('grpc-status')).toBe('8')
  })

  it('keeps waiting through a long run of refusals instead of failing over again after a wait', async () => {
    const budget = withNodes()
    let calls = 0
    // Refusals, with another read's good reply in the middle of the run.
    const base = vi.fn(async (input: RequestInfo | URL) =>
      (input as Request).url.endsWith('getDataContractsLatestVersions') ? ok() : ++calls <= 6 ? overLimit(6) : ok(),
    )
    const gated = gatedFetch(base as unknown as typeof fetch, budget)
    const nodes = [NODE, OTHER, THIRD, FOURTH]
    const replies: (string | null)[] = []
    // Up to 6 SDK attempts, one node after another, as rs-dapi-client makes them.
    for (let attempt = 0; attempt < 6 && replies.at(-1) !== '0'; attempt++) {
      if (attempt === 1) await gated(`${OTHER}//org.dash.platform.dapi.v0.Platform/getDataContractsLatestVersions`, { method: 'POST' })
      const pending = gated(`${nodes[attempt % 4]}//org.dash.platform.dapi.v0.Platform/getDocuments`, { method: 'POST' })
      for (let t = 0; t < 120 && !(await settled(pending)); t++) await vi.advanceTimersByTimeAsync(500)
      replies.push((await pending).headers.get('grpc-status'))
    }
    expect(replies.at(-1), JSON.stringify({ replies, calls })).toBe('0')
    expect(replies.filter((r) => r === '8').length).toBeLessThanOrEqual(2)
  })

  it('refuses a request to a held node without sending it, while other nodes are free', async () => {
    const budget = withNodes()
    budget.hold(NODE, Date.now() + 20_000)
    const base = vi.fn(async () => ok())
    const pending = gatedFetch(base as unknown as typeof fetch, budget)(METHOD, { method: 'POST' })
    expect(await settled(pending)).toBe(true)
    expect((await pending).headers.get('grpc-message')).toBe('rate limited')
    expect(base).not.toHaveBeenCalled()
  })

  it('sits out a short reset on the same node, with the same body', async () => {
    const budget = withNodes()
    const bodies: number[][] = []
    const base = vi.fn(async (input: RequestInfo | URL) => {
      bodies.push([...new Uint8Array(await (input as Request).arrayBuffer())])
      return bodies.length === 1 ? overLimit(1) : ok()
    })
    const pending = gatedFetch(base as unknown as typeof fetch, budget)(METHOD, { method: 'POST', body: new Uint8Array([0, 0, 0, 0, 5]) })
    await vi.advanceTimersByTimeAsync(0)
    expect(budget.status().cause).toBe('rate-limit')
    await vi.advanceTimersByTimeAsync(2500)
    expect((await pending).headers.get('grpc-status')).toBe('0')
    expect(bodies).toEqual([[0, 0, 0, 0, 5], [0, 0, 0, 0, 5]])
  })

  it('waits for the node when the IP is busy everywhere, within the call deadline', async () => {
    const budget = withNodes()
    for (const n of [OTHER, THIRD, FOURTH]) budget.hold(n, Date.now() + 40_000)
    let calls = 0
    const base = vi.fn(async () => (++calls === 1 ? overLimit(10) : ok()))
    const pending = gatedFetch(base as unknown as typeof fetch, budget)(METHOD, { method: 'POST' })
    await vi.advanceTimersByTimeAsync(0)
    expect(budget.status().cause).toBe('rate-limit')
    await vi.advanceTimersByTimeAsync(12_000)
    expect((await pending).headers.get('grpc-status')).toBe('0')
    expect(calls).toBe(2)
  })

  it('gives the refusal back once the call deadline would pass', async () => {
    const budget = new RequestBudget()
    const base = vi.fn(async () => overLimit(60))
    const pending = gatedFetch(base as unknown as typeof fetch, budget)(METHOD, { method: 'POST' })
    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS + 5000)
    expect((await pending).headers.get('grpc-status')).toBe('8')
    expect(base).toHaveBeenCalledTimes(2)
  })

  it('does not hold a node for a ResourceExhausted that is not a rate limit', async () => {
    const budget = withNodes()
    const base = vi.fn(async () => grpcReply({ 'grpc-status': '8', 'grpc-message': 'mempool is full', 'ratelimit-remaining': '90', 'ratelimit-reset': '30' }))
    await gatedFetch(base as unknown as typeof fetch, budget)(METHOD, { method: 'POST' })
    expect(budget.waitFor(NODE).ms).toBe(0)
  })

  it('pauses a node whose window is nearly spent', async () => {
    const budget = withNodes()
    await gatedFetch((async () => ok(LOW_WATER, 7)) as unknown as typeof fetch, budget)(METHOD, { method: 'POST' })
    const wait = budget.waitFor(NODE)
    expect(wait.cause).toBe('rate-limit')
    expect(wait.ms).toBeGreaterThanOrEqual(7000)
    expect(wait.ms).toBeLessThan(8000)
  })

  it('keeps an unreachable node out of rotation for a short time', async () => {
    const budget = withNodes()
    const base = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const gated = gatedFetch(base as unknown as typeof fetch, budget)
    await expect(gated(METHOD, { method: 'POST' })).rejects.toThrow('Failed to fetch')
    const next = await gated(METHOD, { method: 'POST' })
    expect(next.headers.get('grpc-status')).toBe('14')
    expect(base).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(DOWN_MS)
    await expect(gated(METHOD, { method: 'POST' })).rejects.toThrow('Failed to fetch')
    expect(base).toHaveBeenCalledTimes(2)
  })

  it('waits briefly for its own pacing instead of failing over', async () => {
    const budget = withNodes()
    drain(budget, NODE)
    const base = vi.fn(async () => ok())
    const pending = gatedFetch(base as unknown as typeof fetch, budget)(METHOD, { method: 'POST' })
    expect(await settled(pending)).toBe(false)
    await vi.advanceTimersByTimeAsync(SHORT_WAIT_MS)
    expect((await pending).headers.get('grpc-status')).toBe('0')
  })

  it('passes other requests straight through', async () => {
    const budget = withNodes()
    budget.hold(NODE, Date.now() + 60_000)
    const base = vi.fn(async () => new Response('ok'))
    const gated = gatedFetch(base as unknown as typeof fetch, budget)
    expect(await settled(gated(`${NODE}/`))).toBe(true)
    expect(await settled(gated('https://example.com/pack'))).toBe(true)
    expect(base).toHaveBeenCalledTimes(2)
  })
})
