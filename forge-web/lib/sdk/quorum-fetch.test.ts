import { afterEach, describe, expect, it, vi } from 'vitest'

import { isQuorumKeyRequest, QUORUM_CACHE_MAX_AGE_MS, QUORUM_FETCH_TIMEOUT_MS, quorumFetch, type QuorumStorage } from './quorum-fetch'

const BASE = 'https://quorums.testnet.networks.dash.org'
const LIST = JSON.stringify({ success: true, data: [{ quorum_hash: '00ab', key: '88c1' }] })

function memory(): QuorumStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

/** A fetch that answers after `ms` (or never, with `ms` null), honoring its abort signal. */
function slowFetch(ms: number | null, body = LIST, status = 200): typeof fetch {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const timer = ms === null ? undefined : setTimeout(() => resolve(new Response(body, { status })), ms)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      })
    }),
  ) as unknown as typeof fetch
}

afterEach(() => {
  vi.useRealTimers()
})

describe('isQuorumKeyRequest', () => {
  it('matches only the key lists of the configured service', () => {
    expect(isQuorumKeyRequest(`${BASE}/quorums`, BASE)).toBe(true)
    expect(isQuorumKeyRequest(`${BASE}/previous`, BASE)).toBe(true)
    expect(isQuorumKeyRequest(`${BASE}/masternodes?x=1`, BASE)).toBe(true)
    expect(isQuorumKeyRequest(`${BASE}/other`, BASE)).toBe(false)
    expect(isQuorumKeyRequest('https://quorums.mainnet.networks.dash.org/quorums', BASE)).toBe(false)
    expect(isQuorumKeyRequest('https://68.67.122.3:1443/org.dash.platform.dapi.v0.Platform/getDocuments', BASE)).toBe(false)
    expect(isQuorumKeyRequest(`${BASE}/quorums`, '')).toBe(false)
  })
})

describe('quorumFetch', () => {
  it('a 6 s answer arrives even though the SDK aborts its request at 5 s (the "never loads" repro)', async () => {
    vi.useFakeTimers()
    const storage = memory()
    const f = quorumFetch(slowFetch(6_000), () => BASE, { storage: () => storage, now: () => Date.now() })
    const sdkAbort = new AbortController()
    const answer = f(new Request(`${BASE}/quorums`, { signal: sdkAbort.signal }))
    await vi.advanceTimersByTimeAsync(5_000)
    sdkAbort.abort()
    await vi.advanceTimersByTimeAsync(1_000)
    const response = await answer
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(LIST)
    // kept for the next connect
    expect(storage.map.size).toBe(1)
  })

  it('gives up after QUORUM_FETCH_TIMEOUT_MS when nothing is kept, with a timeout the UI recognizes', async () => {
    vi.useFakeTimers()
    const f = quorumFetch(slowFetch(null), () => BASE, { storage: () => memory(), now: () => Date.now() })
    const answer = f(`${BASE}/quorums`)
    const settled = expect(answer).rejects.toThrow(`timed out after ${QUORUM_FETCH_TIMEOUT_MS / 1000} s`)
    await vi.advanceTimersByTimeAsync(QUORUM_FETCH_TIMEOUT_MS)
    await settled
  })

  it('falls back to the kept keys when the service is too slow or fails, while they are young enough', async () => {
    vi.useFakeTimers()
    const storage = memory()
    let now = 1_000_000
    const onCached = vi.fn()
    const first = quorumFetch(slowFetch(10), () => BASE, { storage: () => storage, now: () => now })(`${BASE}/previous`)
    await vi.advanceTimersByTimeAsync(10)
    await first
    const hung = quorumFetch(slowFetch(null), () => BASE, { storage: () => storage, now: () => now, onCached })
    now += 60_000
    const late = hung(`${BASE}/previous`)
    await vi.advanceTimersByTimeAsync(QUORUM_FETCH_TIMEOUT_MS)
    const kept = await late
    expect(await kept.text()).toBe(LIST)
    // wasm-sdk parses the response's URL; an empty one fails the connect ("url parse").
    expect(kept.url).toBe(`${BASE}/previous`)
    expect(onCached).toHaveBeenCalledWith(1_000_000)

    const failing = quorumFetch(slowFetch(10, 'busy', 503), () => BASE, { storage: () => storage, now: () => now })
    const busy = failing(`${BASE}/previous`)
    await vi.advanceTimersByTimeAsync(10)
    expect(await (await busy).text()).toBe(LIST)

    now += QUORUM_CACHE_MAX_AGE_MS
    const stale = failing(`${BASE}/previous`)
    await vi.advanceTimersByTimeAsync(10)
    const r = await stale
    expect(r.status).toBe(503)
  })

  it('keeps /previous, whose data is an object ({height, quorums}), not a list', async () => {
    const storage = memory()
    const previous = JSON.stringify({ success: true, data: { height: 1597491, quorums: [{ quorum_hash: '00cd', key: '8566' }] } })
    await quorumFetch(slowFetch(0, previous), () => BASE, { storage: () => storage, now: () => 1 })(`${BASE}/previous`)
    expect(storage.map.get(`forge.quorumKeys.${BASE}/previous`)).toContain('1597491')
  })

  it('never keeps an empty list, and ignores an entry dated in the future', async () => {
    const storage = memory()
    await quorumFetch(slowFetch(0, '{"success":true,"data":[]}'), () => BASE, { storage: () => storage, now: () => 1 })(`${BASE}/quorums`)
    expect(storage.map.size).toBe(0)
    storage.map.set(`forge.quorumKeys.${BASE}/quorums`, JSON.stringify({ at: 10 * 60_000, body: LIST }))
    const failing = quorumFetch(slowFetch(0, 'busy', 503), () => BASE, { storage: () => storage, now: () => 1 })
    expect((await failing(`${BASE}/quorums`)).status).toBe(503)
  })

  it('never keeps an answer that is not a key list, and passes other requests through untouched', async () => {
    const storage = memory()
    const base = slowFetch(0, '{"success":false}')
    const f = quorumFetch(base, () => BASE, { storage: () => storage, now: () => 1 })
    await f(`${BASE}/quorums`)
    expect(storage.map.size).toBe(0)
    const init = { method: 'POST', body: 'x' }
    await f('https://68.67.122.3:1443/org.dash.platform.dapi.v0.Platform/getDocuments', init)
    expect(base).toHaveBeenLastCalledWith('https://68.67.122.3:1443/org.dash.platform.dapi.v0.Platform/getDocuments', init)
  })
})
