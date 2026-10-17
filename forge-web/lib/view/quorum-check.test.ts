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
  DAPI_METADATA_MAX_AGE_MS,
  decodeCurrentQuorumsInfo,
  decodeResponseMetadata,
  grpcWebMessage,
  metadataFault,
  protoFields,
  type ResponseMetadata,
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

/** The captured response carries its block time (2026-09-26); every test that uses it reads the clock from there. */
const CAPTURED_AT_MS = 1_790_451_378_268
const capturedNow = (): number => CAPTURED_AT_MS + 60_000

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
    const r = await crossCheckQuorumKeys(config(['https://10.0.0.1:1443']), { fetch, random: () => 0, now: capturedNow })
    expect(r).toEqual({ state: 'agreed', primary: 'quorums.moutai.networks.dash.org', secondary: '10.0.0.1:1443', overlap: 4 })
  })

  it('tries further DAPI nodes when the first is down', async () => {
    const { fetch, calls } = fakeFetch({ [SVC]: service, [rpc('10.0.0.2')]: dapi() })
    const r = await crossCheckQuorumKeys(config(['https://10.0.0.1:1443', 'https://10.0.0.2:1443']), {
      fetch,
      random: () => 0.99, // keep the order
      now: capturedNow,
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
    const r = await crossCheckQuorumKeys(config(['https://10.0.0.1:1443']), { fetch, now: capturedNow })
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
    const r = await crossCheckQuorumKeys(config(['https://10.0.0.1:1443']), { fetch, rotationRetriesMs: [0, 0, 0], now: capturedNow })
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
    const r = await crossCheckQuorumKeys(config(['https://10.0.0.1:1443']), { fetch, random: () => 0, rotationRetriesMs: [0, 0, 0, 0], now: capturedNow })
    expect(r.state).toBe('agreed')
    expect(reads).toBe(4)
  })

  it('cannot compare when the quorum service is down', async () => {
    const { fetch } = fakeFetch({})
    const r = await crossCheckQuorumKeys(config(['https://10.0.0.1:1443']), { fetch, now: capturedNow })
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
    expect(await reason(probeQuorumService(CAND, [node], { fetch, now: capturedNow }))).toBe('ok')
  })

  it('takes a service that answers when no node does', async () => {
    const fetch = serve({ [`${CAND}/quorums`]: () => Response.json(fixture.quorumService) })
    expect(await reason(probeQuorumService(CAND, [node], { fetch, now: capturedNow }))).toBe('ok')
  })

  it('refuses a service that does not answer, another network\'s, and contradicting keys', async () => {
    expect(await reason(probeQuorumService(CAND, [node], { fetch: serve({ [rpc]: dapi }), now: capturedNow }))).toBe('no-answer')
    const elsewhere = serve({ [`${CAND}/quorums`]: () => Response.json(other), [rpc]: dapi })
    expect(await reason(probeQuorumService(CAND, [node], { fetch: elsewhere, now: capturedNow }))).toBe('other-network')
    const lying = serve({ [`${CAND}/quorums`]: () => Response.json(forged), [rpc]: dapi })
    expect(await reason(probeQuorumService(CAND, [node], { fetch: lying, now: capturedNow }))).toBe('keys-differ')
  })
})

// ---------------------------------------------------------------------------
// TEST-04 / WEB-V-02: a node whose answer is stale is not a second source
// ---------------------------------------------------------------------------

const enc = new TextEncoder()
function varint(n: number): number[] {
  const out: number[] = []
  let v = n
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80)
    v = Math.floor(v / 0x80)
  }
  out.push(v)
  return out
}
const intField = (no: number, n: number): number[] => [...varint(no * 8), ...varint(n)]
const bytesField = (no: number, b: ArrayLike<number>): number[] => [...varint(no * 8 + 2), ...varint(b.length), ...Array.from(b)]

/** A grpc-web `GetCurrentQuorumsInfoResponse` carrying `sets` and, unless null, this metadata. */
function dapiBody(sets: readonly QuorumKey[], meta: ResponseMetadata | null): Uint8Array {
  const v0: number[] = []
  for (const s of sets) {
    v0.push(...bytesField(3, [...bytesField(1, hexBytes(s.hash)), ...intField(2, s.height), ...bytesField(4, hexBytes(s.key))]))
  }
  if (meta !== null) {
    const md: number[] = []
    if (meta.height !== undefined) md.push(...intField(1, meta.height))
    if (meta.timeMs !== undefined) md.push(...intField(4, meta.timeMs))
    if (meta.protocolVersion !== undefined) md.push(...intField(5, meta.protocolVersion))
    if (meta.chainId !== undefined) md.push(...bytesField(6, enc.encode(meta.chainId)))
    v0.push(...bytesField(5, md))
  }
  const message = bytesField(1, v0)
  const n = message.length
  return new Uint8Array([0, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...message])
}

describe('decodeResponseMetadata', () => {
  it('reads the metadata of the captured moutai response', () => {
    expect(decodeResponseMetadata(grpcWebMessage(DAPI_BODY))).toEqual({
      height: 11322,
      coreChainLockedHeight: 88117,
      epoch: undefined,
      timeMs: CAPTURED_AT_MS,
      protocolVersion: 14,
      chainId: 'dash-devnet-moutai',
    })
  })

  it('round-trips a time in ms (past 2^32) and leaves the validator sets alone', () => {
    const meta: ResponseMetadata = { height: 624_215, timeMs: 1_792_195_200_000, protocolVersion: 14, chainId: 'dash-testnet-51' }
    const body = dapiBody(SERVICE, meta)
    expect(decodeResponseMetadata(grpcWebMessage(body))).toMatchObject(meta)
    expect(decodeCurrentQuorumsInfo(grpcWebMessage(body))).toHaveLength(SERVICE.length)
  })

  it('is null when the node sent no metadata', () => {
    expect(decodeResponseMetadata(grpcWebMessage(dapiBody(SERVICE, null)))).toBeNull()
    // protoFields still parses what the encoder wrote
    expect(protoFields(grpcWebMessage(dapiBody(SERVICE, null)))).toHaveLength(1)
  })
})

describe('metadataFault', () => {
  const NOW = 1_800_000_000_000
  const fresh: ResponseMetadata = { timeMs: NOW - 5_000, protocolVersion: 14, chainId: 'dash-testnet-51' }

  it('accepts a fresh protocol-14 node on the right chain, and an answer with no metadata', () => {
    expect(metadataFault(fresh, NOW, 'dash-testnet-51')).toBeNull()
    expect(metadataFault(null, NOW, 'dash-testnet-51')).toBeNull()
  })

  it('refuses protocol 13, a block older than the SDK tolerates, and another chain', () => {
    expect(metadataFault({ ...fresh, protocolVersion: 13 }, NOW, null)).toMatch(/protocol 13/)
    expect(metadataFault({ ...fresh, timeMs: NOW - DAPI_METADATA_MAX_AGE_MS - 1 }, NOW, null)).toMatch(/minutes old/)
    expect(metadataFault({ ...fresh, timeMs: NOW - DAPI_METADATA_MAX_AGE_MS }, NOW, null)).toBeNull()
    expect(metadataFault({ ...fresh, chainId: 'dash-devnet-x' }, NOW, 'dash-testnet-51')).toMatch(/dash-devnet-x/)
  })

  it('does not check the chain when the network records none, nor blame a node for a fast device clock', () => {
    expect(metadataFault({ ...fresh, chainId: 'dash-devnet-x' }, NOW, null)).toBeNull()
    expect(metadataFault({ ...fresh, timeMs: NOW + 10 * 60_000 }, NOW, null)).toBeNull()
  })
})

describe('the cross-check skips a stale node (TEST-04)', () => {
  const NOW = 1_800_000_000_000
  const CHAIN = 'dash-devnet-moutai'
  const fresh: ResponseMetadata = { height: 624_000, timeMs: NOW - 4_000, protocolVersion: 14, chainId: CHAIN }
  const config = (dapi: readonly string[], chainId: string | null = CHAIN): NetworkConfig => ({
    network: 'devnet',
    devnetName: 'moutai',
    key: 'devnet-moutai',
    dapiAddresses: dapi,
    quorumBaseUrl: null,
    chainId,
    dpnsContractId: 'dpns',
    v2: null,
  })
  const SVC = 'https://quorums.moutai.networks.dash.org/quorums'
  const rpc = (host: string): string => `https://${host}:1443/org.dash.platform.dapi.v0.Platform/getCurrentQuorumsInfo`
  const GOOD = 'https://10.0.0.1:1443'
  const STALE = 'https://10.0.0.2:1443'
  const reply = (body: Uint8Array) => (): Response => new Response(body.slice(), { headers: { 'content-type': 'application/grpc-web+proto' } })

  /** Quorums that are nobody's current ones: what a node stuck on an old block lists. */
  const OLD_SETS: QuorumKey[] = [{ hash: 'ee'.repeat(32), key: 'dd'.repeat(48), height: 1 }]

  function serve(routes: Record<string, () => Response>): { fetch: typeof fetch; calls: string[] } {
    const calls: string[] = []
    const f = (input: RequestInfo | URL): Promise<Response> => {
      calls.push(String(input))
      const route = routes[String(input)]
      return route ? Promise.resolve(route()) : Promise.reject(new TypeError('connection refused'))
    }
    return { fetch: f as typeof fetch, calls }
  }
  const service = (): Response => Response.json(fixture.quorumService)
  const goodBody = dapiBody(SERVICE, fresh)
  const oldBlock: ResponseMetadata = { ...fresh, timeMs: NOW - DAPI_METADATA_MAX_AGE_MS - 60_000 }
  const protocol13: ResponseMetadata = { ...fresh, protocolVersion: 13 }
  const staleVariants: Record<string, ResponseMetadata> = {
    'a block older than the SDK tolerates': oldBlock,
    'protocol 13': protocol13,
    'another chain': { ...fresh, chainId: 'dash-devnet-x' },
  }

  for (const [name, meta] of Object.entries(staleVariants)) {
    it(`falls through to the next node on ${name}`, async () => {
      const { fetch, calls } = serve({ [SVC]: service, [rpc('10.0.0.2')]: reply(dapiBody(OLD_SETS, meta)), [rpc('10.0.0.1')]: reply(goodBody) })
      // random: 0.99 keeps the order [GOOD, STALE]; reverse it so the stale node is asked first
      const r = await crossCheckQuorumKeys(config([STALE, GOOD]), { fetch, random: () => 0.99, now: () => NOW, rotationRetriesMs: [0] })
      expect(r).toEqual({ state: 'agreed', primary: 'quorums.moutai.networks.dash.org', secondary: '10.0.0.1:1443', overlap: SERVICE.length })
      expect(calls.filter((c) => c.includes('getCurrentQuorumsInfo'))).toHaveLength(2)
    })
  }

  it('with only stale nodes reports a single source at once, not unavailable after a minute of retries', async () => {
    const stale = reply(dapiBody(OLD_SETS, protocol13))
    const { fetch, calls } = serve({ [SVC]: service, [rpc('10.0.0.2')]: stale, [rpc('10.0.0.3')]: stale })
    const r = await crossCheckQuorumKeys(config([STALE, 'https://10.0.0.3:1443']), { fetch, now: () => NOW })
    expect(r).toEqual({ state: 'single', primary: 'quorums.moutai.networks.dash.org', reason: 'second-unreachable' })
    // the service was read once: no rotation retries (ROTATION_RETRIES_MS, about a minute) were spent
    expect(calls.filter((c) => c === SVC)).toHaveLength(1)
  })

  it('does not take the chain id from a network that records none', async () => {
    const other = reply(dapiBody(SERVICE, { ...fresh, chainId: 'dash-devnet-x' }))
    const { fetch } = serve({ [SVC]: service, [rpc('10.0.0.1')]: other })
    expect((await crossCheckQuorumKeys(config([GOOD], null), { fetch, now: () => NOW })).state).toBe('agreed')
    expect((await crossCheckQuorumKeys(config([GOOD], CHAIN), { fetch, now: () => NOW })).state).toBe('single')
  })

  it('still accepts an answer with no metadata, as before', async () => {
    const { fetch } = serve({ [SVC]: service, [rpc('10.0.0.1')]: reply(dapiBody(SERVICE, null)) })
    expect((await crossCheckQuorumKeys(config([GOOD]), { fetch, now: () => NOW })).state).toBe('agreed')
  })

  it('probeQuorumService no longer calls a valid service another network\'s because a node is stale', async () => {
    const CAND = 'https://q.example.org'
    const stale = reply(dapiBody(OLD_SETS, oldBlock))
    // before the guard the stale node's own (old) quorums read as "none of the service's quorums": other-network
    const { fetch } = serve({ [`${CAND}/quorums`]: service, [rpc('10.0.0.2')]: stale })
    await expect(probeQuorumService(CAND, [STALE], { fetch, now: () => NOW })).resolves.toBeUndefined()
    // a fresh node on the same old quorums is still what it was: another network's service
    const fresher = serve({ [`${CAND}/quorums`]: service, [rpc('10.0.0.2')]: reply(dapiBody(OLD_SETS, fresh)) })
    await expect(probeQuorumService(CAND, [STALE], { fetch: fresher.fetch, now: () => NOW })).rejects.toBeInstanceOf(QuorumProbeError)
  })
})
