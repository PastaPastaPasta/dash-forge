/**
 * Quorum-key cross-check: the hand-written grpc-web/protobuf decoder against a real captured
 * DAPI response, the comparison rules, and the fetch orchestration (second source, rotation
 * retry, honest single-source outcome).
 */

import { describe, expect, it, vi } from 'vitest'

import type { NetworkConfig } from '../constants'
import fixture from './fixtures/moutai-quorums.json'
import {
  QUORUM_CHECK_MAX_AGE_MS,
  compareQuorumKeys,
  crossCheckQuorumKeys,
  ROTATION_REASON,
  ROTATION_RETRIES_MS,
  crossCheckQuorumKeysCached,
  lastQuorumCheck,
  quorumCheckDueInMs,
  resetQuorumChecks,
  type QuorumCrossCheck,
  decodeCurrentQuorumsInfo,
  grpcWebMessage,
  parseQuorumService,
  probeQuorumService,
  QuorumProbeError,
  type QuorumKey,
} from './quorum-check'

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const DAPI_BODY = hexBytes(fixture.dapiGrpcWebHex)
const SERVICE = parseQuorumService(fixture.quorumService)

describe('decodeCurrentQuorumsInfo (captured moutai response)', () => {
  it('decodes every validator set with its 48-byte threshold key', () => {
    const keys = decodeCurrentQuorumsInfo(grpcWebMessage(DAPI_BODY))
    expect(keys).toHaveLength(4)
    expect(keys[0]).toEqual({
      hash: '0000029eaa85521e740e3f626486ac816823ca9a8a79ff3f8fdb7bed6a8b54a6',
      key: '969aac2cf7fe392be0d8aa1866d0b334e63d518bfdb4ab6592e60c6e08bc312b204fc65f6fe24e5b584843edfd6bac1e',
      height: 88104,
    })
    for (const k of keys) expect(k.key).toHaveLength(96)
  })

  it('matches the quorum service byte for byte', () => {
    const dapi = decodeCurrentQuorumsInfo(grpcWebMessage(DAPI_BODY))
    expect(compareQuorumKeys(SERVICE, dapi)).toEqual({ kind: 'agree', overlap: 4 })
  })

  it('rejects an error trailer and a body with no message', () => {
    const trailer = new TextEncoder().encode('grpc-status:14\r\n')
    const frame = new Uint8Array([0x80, 0, 0, 0, trailer.length, ...trailer])
    expect(() => grpcWebMessage(frame)).toThrow(/grpc-status 14/)
    expect(() => grpcWebMessage(new Uint8Array())).toThrow(/no message/)
    expect(() => grpcWebMessage(DAPI_BODY.subarray(0, 40))).toThrow(/truncated/)
  })

  it('rejects malformed quorum-service JSON', () => {
    expect(() => parseQuorumService({ success: true, data: [{ quorum_hash: 'zz', key: 'x', height: 1 }] })).toThrow()
    expect(() => parseQuorumService({ success: false, data: [] })).toThrow()
  })
})

describe('compareQuorumKeys', () => {
  const q = (hash: string, key: string): QuorumKey => ({ hash, key, height: 1 })

  it('accepts extra quorums on the second side only', () => {
    expect(compareQuorumKeys([q('b', 'k2')], [q('b', 'k2'), q('c', 'k3')])).toEqual({ kind: 'agree', overlap: 1 })
  })

  it('does not vouch for a quorum only the primary lists (a forged extra key)', () => {
    expect(compareQuorumKeys([q('a', 'k1'), q('x', 'EVIL')], [q('a', 'k1')])).toEqual({ kind: 'unconfirmed', quorums: ['x'] })
  })

  it('treats a hash listed twice as a mismatch', () => {
    expect(compareQuorumKeys([q('a', 'EVIL'), q('a', 'k1')], [q('a', 'k1')])).toEqual({ kind: 'mismatch', quorums: ['a'] })
  })

  it('reports every shared quorum whose key differs', () => {
    expect(compareQuorumKeys([q('a', 'k1'), q('b', 'k2')], [q('a', 'k1'), q('b', 'EVIL')])).toEqual({ kind: 'mismatch', quorums: ['b'] })
  })

  it('reports disjoint lists as unconfirmed', () => {
    expect(compareQuorumKeys([q('a', 'k1')], [q('b', 'k2')])).toEqual({ kind: 'unconfirmed', quorums: ['a'] })
  })
})

describe('crossCheckQuorumKeys', () => {
  const config = (dapi: readonly string[]): NetworkConfig => ({
    network: 'devnet',
    devnetName: 'moutai',
    key: 'devnet-moutai',
    dapiAddresses: dapi,
    quorumBaseUrl: null,
    dpnsContractId: 'dpns',
    v2: null,
  })

  /** Serve the service JSON and grpc-web bodies per URL; unknown URLs fail. */
  function fakeFetch(routes: Record<string, () => Response>): { fetch: typeof fetch; calls: string[] } {
    const calls: string[] = []
    const f = (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      calls.push(url)
      const route = routes[url]
      return route ? Promise.resolve(route()) : Promise.reject(new TypeError('connection refused'))
    }
    return { fetch: f as typeof fetch, calls }
  }
  const service = (): Response => Response.json(fixture.quorumService)
  const dapi = (body: Uint8Array = DAPI_BODY) => (): Response =>
    new Response(body.slice(), { headers: { 'content-type': 'application/grpc-web+proto' } })
  const SVC = 'https://quorums.moutai.networks.dash.org/quorums'
  const rpc = (host: string): string => `https://${host}:1443/org.dash.platform.dapi.v0.Platform/getCurrentQuorumsInfo`

  it('agrees when a DAPI node returns the same keys', async () => {
    const { fetch } = fakeFetch({ [SVC]: service, [rpc('10.0.0.1')]: dapi() })
    const r = await crossCheckQuorumKeys(config(['https://10.0.0.1:1443']), { fetch, random: () => 0 })
    expect(r).toEqual({ state: 'agreed', primary: 'quorums.moutai.networks.dash.org', secondary: '10.0.0.1:1443', overlap: 4 })
  })

  it('tries further DAPI nodes when the first is down', async () => {
    const { fetch, calls } = fakeFetch({ [SVC]: service, [rpc('10.0.0.2')]: dapi() })
    const r = await crossCheckQuorumKeys(config(['https://10.0.0.1:1443', 'https://10.0.0.2:1443']), {
      fetch,
      random: () => 0.99, // keep the order
    })
    expect(r.state).toBe('agreed')
    expect(calls.filter((c) => c.includes('getCurrentQuorumsInfo'))).toHaveLength(2)
  })

  it('is loud about a key that differs', async () => {
    const tampered = DAPI_BODY.slice()
    // The first validator set's key starts with `969aac2c`; flip a byte inside it.
    const at = fixture.dapiGrpcWebHex.indexOf('969aac2cf7fe') / 2
    tampered[at + 3]! ^= 0xff
    const { fetch } = fakeFetch({ [SVC]: service, [rpc('10.0.0.1')]: dapi(tampered) })
    const r = await crossCheckQuorumKeys(config(['https://10.0.0.1:1443']), { fetch })
    expect(r.state).toBe('mismatch')
    if (r.state === 'mismatch') expect(r.quorums).toEqual(['0000029eaa85521e740e3f626486ac816823ca9a8a79ff3f8fdb7bed6a8b54a6'])
  })

  it('reports a single source when no DAPI list is recorded, or none answers', async () => {
    const { fetch } = fakeFetch({ [SVC]: service })
    expect(await crossCheckQuorumKeys(config([]), { fetch })).toEqual({
      state: 'single',
      primary: 'quorums.moutai.networks.dash.org',
      reason: 'no-second-source',
    })
    expect(await crossCheckQuorumKeys(config(['https://10.0.0.9:1443']), { fetch })).toMatchObject({
      state: 'single',
      reason: 'second-unreachable',
    })
  })

  it('re-reads through a rotation boundary, then gives up', async () => {
    const other = { success: true, data: [{ quorum_hash: 'ff'.repeat(32), key: 'aa'.repeat(48), height: 1 }] }
    const { fetch, calls } = fakeFetch({ [SVC]: () => Response.json(other), [rpc('10.0.0.1')]: dapi() })
    const r = await crossCheckQuorumKeys(config(['https://10.0.0.1:1443']), { fetch, rotationRetriesMs: [0, 0, 0] })
    expect(r).toEqual({ state: 'unavailable', reason: ROTATION_REASON })
    expect(calls.filter((c) => c === SVC)).toHaveLength(4)
  })

  // QW4-016: the quorum service lags DAPI by about 50 s after a rotation; one retry 2 s later
  // settled the page on "Partly verified" for the whole lag.
  it('waits out a lagging source for about a minute, and agrees once it catches up', async () => {
    expect(ROTATION_RETRIES_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(55_000)
    const other = { success: true, data: [{ quorum_hash: 'ff'.repeat(32), key: 'aa'.repeat(48), height: 1 }] }
    let reads = 0
    const { fetch } = fakeFetch({ [SVC]: () => (++reads < 4 ? Response.json(other) : service()), [rpc('10.0.0.1')]: dapi() })
    const r = await crossCheckQuorumKeys(config(['https://10.0.0.1:1443']), { fetch, random: () => 0, rotationRetriesMs: [0, 0, 0, 0] })
    expect(r.state).toBe('agreed')
    expect(reads).toBe(4)
  })

  it('cannot compare when the quorum service is down', async () => {
    const { fetch } = fakeFetch({})
    const r = await crossCheckQuorumKeys(config(['https://10.0.0.1:1443']), { fetch })
    expect(r.state).toBe('unavailable')
  })
})

describe('crossCheckQuorumKeysCached (L3)', () => {
  const cfg = { key: 'devnet-cache-test' } as NetworkConfig
  const agreed: QuorumCrossCheck = { state: 'agreed', primary: 'q', secondary: 'd', overlap: 4 }

  it('does not re-run on a reconnect, re-runs once the result is an hour old, and keeps the previous result meanwhile', async () => {
    resetQuorumChecks()
    let t = 0
    const now = () => t
    const check = vi.fn(async (): Promise<QuorumCrossCheck> => agreed)
    await crossCheckQuorumKeysCached(cfg, { now, check })
    t += 5 * 60_000 // a routine 5-minute reconnect
    await crossCheckQuorumKeysCached(cfg, { now, check })
    expect(check).toHaveBeenCalledTimes(1)
    t += QUORUM_CHECK_MAX_AGE_MS
    let release: (r: QuorumCrossCheck) => void = () => undefined
    check.mockImplementationOnce(() => new Promise((r) => (release = r)))
    const rerun = crossCheckQuorumKeysCached(cfg, { now, check })
    expect(check).toHaveBeenCalledTimes(2)
    // While it re-runs the card keeps the previous answer instead of "Checking…".
    expect(lastQuorumCheck(cfg)).toEqual(agreed)
    release({ state: 'single', primary: 'q', reason: 'no-second-source' })
    await expect(rerun).resolves.toMatchObject({ state: 'single' })
    await Promise.resolve()
    expect(lastQuorumCheck(cfg)).toMatchObject({ state: 'single' })
  })

  it('re-runs a transient outcome on the next view', async () => {
    resetQuorumChecks()
    const check = vi.fn(async (): Promise<QuorumCrossCheck> => ({ state: 'unavailable', reason: 'down' }))
    await crossCheckQuorumKeysCached(cfg, { check })
    await Promise.resolve()
    await crossCheckQuorumKeysCached(cfg, { check })
    expect(check).toHaveBeenCalledTimes(2)
  })
})

describe('crossCheckQuorumKeysCached: a check that throws', () => {
  it('reports unavailable and lets the next view run it again', async () => {
    resetQuorumChecks()
    const cfg = { key: 'devnet-throws' } as NetworkConfig
    const check = vi
      .fn<(c: NetworkConfig) => Promise<QuorumCrossCheck>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ state: 'single', primary: 'q', reason: 'no-second-source' })
    await expect(crossCheckQuorumKeysCached(cfg, { check })).resolves.toMatchObject({ state: 'unavailable' })
    await Promise.resolve()
    await expect(crossCheckQuorumKeysCached(cfg, { check })).resolves.toMatchObject({ state: 'single' })
    expect(check).toHaveBeenCalledTimes(2)
  })
})

describe('quorumCheckDueInMs', () => {
  it('counts from when the result settled, not from when a view mounted', async () => {
    resetQuorumChecks()
    const cfg = { key: 'devnet-due' } as NetworkConfig
    let t = 1_000
    await crossCheckQuorumKeysCached(cfg, { now: () => t, check: async () => ({ state: 'single', primary: 'q', reason: 'no-second-source' }) })
    await Promise.resolve()
    t += 59 * 60_000 // a view mounting 59 minutes later
    expect(quorumCheckDueInMs(cfg, t)).toBe(60_000)
    expect(quorumCheckDueInMs({ key: 'devnet-none' } as NetworkConfig, t)).toBe(0)
  })
})

describe('quorumCheckDueInMs: a transient outcome', () => {
  it('is due at once, so "the comparison couldn\'t run" does not stay up for an hour', async () => {
    resetQuorumChecks()
    const cfg = { key: 'devnet-transient-due' } as NetworkConfig
    await crossCheckQuorumKeysCached(cfg, { now: () => 0, check: async () => ({ state: 'unavailable', reason: 'offline' }) })
    await Promise.resolve()
    expect(quorumCheckDueInMs(cfg, 1_000)).toBe(0)
  })
})

describe('probeQuorumService (Settings)', () => {
  const CAND = 'https://q.example.org'
  const node = 'https://10.0.0.1:1443'
  const rpc = `${node}/org.dash.platform.dapi.v0.Platform/getCurrentQuorumsInfo`
  const dapi = (): Response => new Response(DAPI_BODY.slice(), { headers: { 'content-type': 'application/grpc-web+proto' } })
  const serve = (routes: Record<string, () => Response>): typeof fetch =>
    ((input: RequestInfo | URL) => {
      const route = routes[String(input)]
      return route ? Promise.resolve(route()) : Promise.reject(new TypeError('connection refused'))
    }) as typeof fetch
  const reason = async (p: Promise<void>): Promise<string> =>
    p.then(
      () => 'ok',
      (e: unknown) => (e instanceof QuorumProbeError ? e.reason : String(e)),
    )
  const other = { ...fixture.quorumService, data: fixture.quorumService.data.map((q) => ({ ...q, quorum_hash: q.quorum_hash.replace(/^../, 'ff') })) }
  const forged = { ...fixture.quorumService, data: fixture.quorumService.data.map((q, i) => (i === 0 ? { ...q, key: q.key.replace(/^../, q.key.startsWith('aa') ? 'bb' : 'aa') } : q)) }

  it('takes a service whose keys a Platform node confirms', async () => {
    const fetch = serve({ [`${CAND}/quorums`]: () => Response.json(fixture.quorumService), [rpc]: dapi })
    expect(await reason(probeQuorumService(CAND, [node], { fetch }))).toBe('ok')
  })

  it('takes a service that answers when no node does', async () => {
    const fetch = serve({ [`${CAND}/quorums`]: () => Response.json(fixture.quorumService) })
    expect(await reason(probeQuorumService(CAND, [node], { fetch }))).toBe('ok')
  })

  it('refuses a service that does not answer, another network\'s, and contradicting keys', async () => {
    expect(await reason(probeQuorumService(CAND, [node], { fetch: serve({ [rpc]: dapi }) }))).toBe('no-answer')
    const elsewhere = serve({ [`${CAND}/quorums`]: () => Response.json(other), [rpc]: dapi })
    expect(await reason(probeQuorumService(CAND, [node], { fetch: elsewhere }))).toBe('other-network')
    const lying = serve({ [`${CAND}/quorums`]: () => Response.json(forged), [rpc]: dapi })
    expect(await reason(probeQuorumService(CAND, [node], { fetch: lying }))).toBe('keys-differ')
  })
})
