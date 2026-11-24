import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../repo/pack-mirrors', async (orig) => {
  const real = await orig<typeof import('../repo/pack-mirrors')>()
  return { ...real, mirrorUrisOf: async () => [] }
})

/** What the fake IPFS peer does with a read. */
const peer = { mode: 'serve' as 'serve' | 'hang' | 'fail' | 'corrupt', up: true, dials: true, reads: [] as string[] }

vi.mock('../storage/p2p/peer', () => ({
  IpfsPeer: {
    start: async () => ({
      stats: { bytes: 0, blocks: 0, messages: 0, dials: 0, routingLookups: 0 },
      connect: async () => {
        if (peer.dials) peer.up = true
        return peer.up ? ['peer'] : []
      },
      reachable: () => peer.up,
      stop: async () => undefined,
      readRange: (cid: string, start: number, end: number, { signal, onBlock }: { signal?: AbortSignal; onBlock?: () => void } = {}): Promise<Uint8Array> => {
        peer.reads.push(`${cid.slice(-4)} ${start}-${end}`)
        if (peer.mode === 'fail') return Promise.reject(new Error('no IPFS peer served the block'))
        if (peer.mode === 'hang') return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled'))))
        onBlock?.()
        const out = bytes.slice(start, end)
        if (peer.mode === 'corrupt') out[0] = (out[0] as number) ^ 1
        return Promise.resolve(out)
      },
    }),
  },
}))

import type { PackManifest, RepoRef } from '../repo'
import { overridePeerReads, peerReadsOn, peerReadStats, resetPeerReads, warmPeer } from '../storage/p2p'
import { artifactRangeFetch, loadArtifactBytesProgress, resetExternalFetchState } from './browse-source'
import { overrideDefaultGateways } from './storage-status'

const REPO: RepoRef = {
  forge: { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' },
  repoId: 'PEER',
  ownerId: 'owner',
  name: 'proj',
  visibility: 'public',
}
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const MiB = 1024 * 1024
const bytes = new Uint8Array(2 * MiB + 100).map((_, i) => (i * 13) % 251)
const manifest = (): PackManifest =>
  ({
    packHash: bytesToHex(sha256(bytes)),
    kind: 0,
    sizeBytes: bytes.length,
    objectCount: 0,
    chunkCount: 0,
    storage: 1,
    uris: [`ipfs://${CID}`],
    tips: [],
    supersedes: [],
    createdAt: 1,
    documentId: 'pm',
  }) as unknown as PackManifest
const sdk = {} as EvoSDK

const asked: string[] = []
function serve(url: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url)
  if (u.pathname.endsWith('bafkqaaa')) return Promise.resolve(new Response(''))
  const range = new Headers(init?.headers).get('Range')
  asked.push(`${u.host} ${range ?? 'whole'}`)
  if (range === null) return Promise.resolve(new Response(bytes.slice()))
  const [a, b] = range.replace('bytes=', '').split('-').map(Number) as [number, number]
  return Promise.resolve(new Response(bytes.slice(a, b + 1), { status: 206 }))
}

function same(got: Uint8Array, start: number, end: number): void {
  expect(got.length).toBe(end - start)
  expect(bytesToHex(got)).toBe(bytesToHex(bytes.subarray(start, end)))
}

describe('pack reads from IPFS peers first', () => {
  beforeEach(async () => {
    asked.length = 0
    peer.reads.length = 0
    peer.mode = 'serve'
    peer.up = true
    peer.dials = true
    resetExternalFetchState()
    resetPeerReads()
    overridePeerReads(true)
    overrideDefaultGateways(['https://a.example'])
    vi.stubGlobal('fetch', serve)
    await warmPeer()
  })

  afterEach(() => {
    overridePeerReads(false)
    overrideDefaultGateways(null)
    vi.useRealTimers()
    vi.unstubAllGlobals()
    resetExternalFetchState()
    resetPeerReads()
  })

  it('reads a range from a peer, and no gateway is asked', async () => {
    const read = artifactRangeFetch(sdk, REPO, manifest())
    same(await read(0, 256 * 1024), 0, 256 * 1024)
    same(await read(MiB + 5, MiB + 500), MiB + 5, MiB + 500)
    expect(peer.reads).toEqual(['bzdi 0-1048576', `bzdi ${MiB + 5}-${MiB + 500}`])
    expect(asked).toEqual([])
    expect(peerReadStats().served).toBe(2)
  })

  it('reads a whole pack from a peer when it matches the manifest', async () => {
    same(await loadArtifactBytesProgress(sdk, REPO, manifest()), 0, bytes.length)
    expect(asked).toEqual([])
  })

  it('takes a whole pack from a gateway when the peer serves other bytes', async () => {
    peer.mode = 'corrupt'
    same(await loadArtifactBytesProgress(sdk, REPO, manifest()), 0, bytes.length)
    expect(asked).toEqual(['a.example whole'])
  })

  it('goes to a gateway at once when no peer has the pack', async () => {
    peer.mode = 'fail'
    same(await artifactRangeFetch(sdk, REPO, manifest())(10, 400), 10, 400)
    expect(asked).toEqual(['a.example bytes=10-399'])
  })

  it('hands a silent peer read to a gateway after the head start', async () => {
    vi.useFakeTimers()
    peer.mode = 'hang'
    const pending = artifactRangeFetch(sdk, REPO, manifest())(10, 400)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(asked).toEqual([])
    await vi.advanceTimersByTimeAsync(600)
    same(await pending, 10, 400)
    expect(asked).toEqual(['a.example bytes=10-399'])
  })

  it('races a gateway at once while the peer is not up yet, and does not hold that against peer reads', async () => {
    peer.mode = 'hang'
    for (let i = 0; i < 4; i++) {
      peer.up = false
      same(await artifactRangeFetch(sdk, REPO, manifest())(10 + i, 400), 10 + i, 400)
    }
    expect(asked).toHaveLength(4)
    expect(peerReadsOn()).toBe(true)
    expect(peer.reads).toHaveLength(4)
  })

  it('holds cold reads against peer reads when the dial fails too', async () => {
    peer.mode = 'hang'
    peer.up = false
    peer.dials = false
    for (let i = 0; i < 3; i++) same(await artifactRangeFetch(sdk, REPO, manifest())(10 + i, 400), 10 + i, 400)
    expect(peerReadsOn()).toBe(false)
  })

  it('stops asking peers after reads keep falling back', async () => {
    peer.mode = 'fail'
    for (let i = 0; i < 3; i++) await artifactRangeFetch(sdk, REPO, manifest())(i * 1000, i * 1000 + 10)
    peer.reads.length = 0
    await artifactRangeFetch(sdk, REPO, manifest())(5000, 5010)
    expect(peer.reads).toEqual([])
  })
})
