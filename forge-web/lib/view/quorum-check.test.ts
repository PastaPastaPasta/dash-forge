/**
 * Quorum-key cross-check: the hand-written grpc-web/protobuf decoder against a real captured
 * DAPI response, the comparison rules, and the fetch orchestration (second source, rotation
 * retry, honest single-source outcome).
 */

import { describe, expect, it } from 'vitest'

import type { NetworkConfig } from '../constants'
import fixture from './fixtures/moutai-quorums.json'
import {
  compareQuorumKeys,
  crossCheckQuorumKeys,
  decodeCurrentQuorumsInfo,
  grpcWebMessage,
  parseQuorumService,
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
    registryContractId: null,
    registrySource: null,
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

  it('retries once on a rotation boundary, then gives up', async () => {
    const other = { success: true, data: [{ quorum_hash: 'ff'.repeat(32), key: 'aa'.repeat(48), height: 1 }] }
    const { fetch, calls } = fakeFetch({ [SVC]: () => Response.json(other), [rpc('10.0.0.1')]: dapi() })
    const r = await crossCheckQuorumKeys(config(['https://10.0.0.1:1443']), { fetch, retryDelayMs: 0 })
    expect(r).toEqual({ state: 'unavailable', reason: 'the two key sources listed different quorums' })
    expect(calls.filter((c) => c === SVC)).toHaveLength(2)
  })

  it('cannot compare when the quorum service is down', async () => {
    const { fetch } = fakeFetch({})
    const r = await crossCheckQuorumKeys(config(['https://10.0.0.1:1443']), { fetch })
    expect(r.state).toBe('unavailable')
  })
})
