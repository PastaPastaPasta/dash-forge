import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BURST,
  INTERVAL_MS,
  LOW_WATER,
  RATE_LIMIT_RETRIES,
  RequestBudget,
  dapiNodeOf,
  gatedFetch,
  rateLimitWaitMs,
  type BudgetChannel,
  type BudgetStorage,
} from './budget'

const NODE = 'https://68.67.122.254:1443'
const OTHER = 'https://68.67.122.207:1443'
const METHOD = `${NODE}/org.dash.platform.dapi.v0.Platform/getDocuments`

/** An in-memory BroadcastChannel pair: what one posts, the others receive. */
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

function memoryStorage(): BudgetStorage {
  const map = new Map<string, string>()
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

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('RequestBudget', () => {
  it('lets a burst through, then paces one request per interval', async () => {
    const budget = new RequestBudget()
    for (let i = 0; i < BURST; i++) expect(await settled(budget.acquire(NODE))).toBe(true)
    const next = budget.acquire(NODE)
    expect(await settled(next)).toBe(false)
    expect(budget.status().cause).toBe('pacing')
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(await settled(next)).toBe(true)
    expect(budget.status().cause).toBeNull()
  })

  it('never allows more than 120 requests to one node in any 60 s window', async () => {
    const budget = new RequestBudget()
    const sent: number[] = []
    const loop = (async () => {
      for (let i = 0; i < 400; i++) {
        await budget.acquire(NODE)
        sent.push(Date.now())
      }
    })()
    await vi.advanceTimersByTimeAsync(400 * INTERVAL_MS)
    await loop
    let worst = 0
    for (let i = 0; i < sent.length; i++) {
      const start = sent[i] as number
      let n = 0
      for (let j = i; j < sent.length && (sent[j] as number) < start + 60_000; j++) n++
      worst = Math.max(worst, n)
    }
    expect(worst).toBeLessThanOrEqual(120)
    expect(worst).toBeGreaterThan(100)
  })

  it('keeps a separate bucket per node', async () => {
    const budget = new RequestBudget()
    for (let i = 0; i < BURST; i++) await budget.acquire(NODE)
    expect(await settled(budget.acquire(OTHER))).toBe(true)
  })

  it('holds a node until the time it was given and reports a rate-limit wait', async () => {
    const budget = new RequestBudget()
    const seen: (string | null)[] = []
    budget.subscribe(() => seen.push(budget.status().cause))
    budget.hold(NODE, Date.now() + 5000)
    const waiting = budget.acquire(NODE)
    expect(await settled(waiting)).toBe(false)
    expect(budget.status()).toEqual({ waitingUntil: 1_005_000, cause: 'rate-limit' })
    expect(await settled(budget.acquire(OTHER))).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await settled(waiting)).toBe(true)
    expect(seen).toEqual(['rate-limit', null])
  })

  it('stops waiting when the signal aborts', async () => {
    const budget = new RequestBudget()
    budget.hold(NODE, Date.now() + 60_000)
    const controller = new AbortController()
    const waiting = budget.acquire(NODE, controller.signal)
    const outcome = waiting.catch((e: unknown) => (e as Error).name)
    controller.abort()
    expect(await outcome).toBe('AbortError')
    expect(budget.status().cause).toBeNull()
  })

  it('shares takes and holds across tabs', async () => {
    const hub = channelHub()
    const a = new RequestBudget({ channel: hub() })
    const b = new RequestBudget({ channel: hub() })
    for (let i = 0; i < BURST; i++) await a.acquire(NODE)
    expect(await settled(b.acquire(NODE))).toBe(false)
    a.hold(OTHER, Date.now() + 3000)
    expect(await settled(b.acquire(OTHER))).toBe(false)
  })

  it('restores the shared state in a new tab from storage', async () => {
    const storage = memoryStorage()
    const first = new RequestBudget({ storage })
    first.hold(NODE, Date.now() + 10_000)
    const reloaded = new RequestBudget({ storage })
    expect(await settled(reloaded.acquire(NODE))).toBe(false)
    expect(reloaded.status().cause).toBe('rate-limit')
  })
})

describe('rate-limit replies', () => {
  it('reads a grpc-web ResourceExhausted reply and a bare 429', () => {
    expect(rateLimitWaitMs(grpcReply({ 'grpc-status': '8', 'ratelimit-reset': '9' }))).toBe(9000)
    expect(rateLimitWaitMs(grpcReply({ 'ratelimit-reset': '4' }, 429))).toBe(4000)
    expect(rateLimitWaitMs(grpcReply({ 'grpc-status': '8', 'ratelimit-reset': '600' }))).toBe(60_000)
  })

  it('ignores other replies and a limit without a reset', () => {
    expect(rateLimitWaitMs(grpcReply({ 'grpc-status': '0', 'ratelimit-reset': '9' }))).toBeNull()
    expect(rateLimitWaitMs(grpcReply({ 'grpc-status': '5' }))).toBeNull()
    expect(rateLimitWaitMs(grpcReply({ 'grpc-status': '8' }))).toBeNull()
  })

  it('recognises DAPI calls by path', () => {
    expect(dapiNodeOf(METHOD)).toBe(NODE)
    // What the SDK sends: the node address keeps its trailing slash.
    expect(dapiNodeOf(`${NODE}//org.dash.platform.dapi.v0.Platform/getDocuments`)).toBe(NODE)
    expect(dapiNodeOf(`${NODE}/org.dash.platform.dapi.v0.Core/getTransaction`)).toBe(NODE)
    expect(dapiNodeOf('https://quorums.moutai.networks.dash.org/quorums')).toBeNull()
    expect(dapiNodeOf('/_next/static/chunk.js')).toBeNull()
  })
})

describe('gatedFetch', () => {
  it('waits out a rate limit and retries on the same node', async () => {
    const budget = new RequestBudget()
    const calls: string[] = []
    const bodies: number[][] = []
    const base = vi.fn(async (input: RequestInfo | URL) => {
      calls.push((input as Request).url)
      bodies.push([...new Uint8Array(await (input as Request).arrayBuffer())])
      return calls.length === 1 ? grpcReply({ 'grpc-status': '8', 'ratelimit-reset': '3' }) : grpcReply({ 'grpc-status': '0' })
    })
    const gated = gatedFetch(base as unknown as typeof fetch, budget)
    const pending = gated(METHOD, { method: 'POST', body: new Uint8Array([0, 0, 0, 0, 0]) })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    expect(budget.status().cause).toBe('rate-limit')
    await vi.advanceTimersByTimeAsync(4000)
    const response = await pending
    expect(response.headers.get('grpc-status')).toBe('0')
    expect(calls).toEqual([METHOD, METHOD])
    // The retry sends the same bytes.
    expect(bodies).toEqual([[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]])
  })

  it('gives the reply back after the retries run out', async () => {
    const budget = new RequestBudget()
    const base = vi.fn(async () => grpcReply({ 'grpc-status': '8', 'ratelimit-reset': '1' }))
    const gated = gatedFetch(base as unknown as typeof fetch, budget)
    const pending = gated(METHOD, { method: 'POST' })
    await vi.advanceTimersByTimeAsync((RATE_LIMIT_RETRIES + 1) * 3000)
    expect((await pending).headers.get('grpc-status')).toBe('8')
    expect(base).toHaveBeenCalledTimes(RATE_LIMIT_RETRIES + 1)
  })

  it('pauses a node whose window is nearly spent', async () => {
    const budget = new RequestBudget()
    const base = vi.fn(async () =>
      grpcReply({ 'grpc-status': '0', 'ratelimit-remaining': String(LOW_WATER), 'ratelimit-reset': '7' }),
    )
    const gated = gatedFetch(base as unknown as typeof fetch, budget)
    await gated(METHOD, { method: 'POST' })
    expect(await settled(budget.acquire(NODE))).toBe(false)
    expect(budget.status().waitingUntil).toBe(Date.now() + 7000)
  })

  it('passes other requests straight through', async () => {
    const budget = new RequestBudget()
    budget.hold(NODE, Date.now() + 60_000)
    const base = vi.fn(async () => new Response('ok'))
    const gated = gatedFetch(base as unknown as typeof fetch, budget)
    expect(await settled(gated(`${NODE}/`))).toBe(true)
    expect(await settled(gated('https://example.com/pack'))).toBe(true)
  })
})
