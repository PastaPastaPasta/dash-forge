import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../repo/pack-mirrors', async (orig) => {
  const real = await orig<typeof import('../repo/pack-mirrors')>()
  return { ...real, mirrorUrisOf: async () => [] }
})

import type { PackManifest, RepoRef } from '../repo'
import { artifactRangeFetch, forgetDeadMirrors, loadArtifactBytesProgress, resetExternalFetchState } from './browse-source'
import { overrideDefaultGateways } from './storage-status'

const REPO: RepoRef = {
  forge: { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' },
  repoId: 'COALESCE',
  ownerId: 'owner',
  name: 'proj',
  visibility: 'public',
}
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const MiB = 1024 * 1024
const bytes = new Uint8Array(3 * MiB + 100).map((_, i) => (i * 7) % 251)
const manifest = (documentId = 'cm'): PackManifest =>
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
    documentId,
  }) as unknown as PackManifest
const sdk = {} as EvoSDK

/** Each pack request as `host range` (`whole` without one). */
const asked: string[] = []
/** Hosts that never answer: only the reader's own deadline ends their requests. */
const silent = new Set<string>()

function serve(url: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url)
  if (u.pathname.endsWith('bafkqaaa')) return Promise.resolve(new Response(''))
  const range = new Headers(init?.headers).get('Range')
  asked.push(`${u.host} ${range ?? 'whole'}`)
  if (silent.has(u.host)) {
    return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
  }
  if (range === null) return Promise.resolve(new Response(bytes.slice()))
  const [a, b] = range.replace('bytes=', '').split('-').map(Number) as [number, number]
  return Promise.resolve(new Response(bytes.slice(a, b + 1), { status: 206 }))
}

function same(got: Uint8Array, start: number, end: number): void {
  expect(got.length).toBe(end - start)
  expect(bytesToHex(got)).toBe(bytesToHex(bytes.subarray(start, end)))
}

describe('external range coalescing and the hedged whole fetch', () => {
  beforeEach(() => {
    asked.length = 0
    silent.clear()
    resetExternalFetchState()
    overrideDefaultGateways(['https://a.example', 'https://b.example'])
    vi.stubGlobal('fetch', serve)
  })

  afterEach(() => {
    overrideDefaultGateways(null)
    vi.useRealTimers()
    vi.unstubAllGlobals()
    resetExternalFetchState()
  })

  it('reads read-ahead blocks of one mebibyte as one request, and smaller ranges inside it from memory', async () => {
    const read = artifactRangeFetch(sdk, REPO, manifest())
    const block = 256 * 1024
    const got = await Promise.all([read(0, block), read(block, 2 * block), read(3 * block, 4 * block)])
    same(got[0] as Uint8Array, 0, block)
    same(got[1] as Uint8Array, block, 2 * block)
    same(got[2] as Uint8Array, 3 * block, 4 * block)
    same(await read(1000, 1200), 1000, 1200)
    expect(asked).toEqual([`a.example bytes=0-${MiB - 1}`])
  })

  it('keeps a lone small read exact, and clips the last span to the pack', async () => {
    const read = artifactRangeFetch(sdk, REPO, manifest())
    same(await read(MiB + 12, MiB + 900), MiB + 12, MiB + 900)
    same(await read(3 * MiB, 3 * MiB + 100), 3 * MiB, 3 * MiB + 100)
    same(await read(2 * MiB + 1, 3 * MiB + 99), 2 * MiB + 1, 3 * MiB + 99)
    expect(asked).toEqual([`a.example bytes=${MiB + 12}-${MiB + 899}`, `a.example bytes=${3 * MiB}-${3 * MiB + 99}`, `a.example bytes=${2 * MiB + 1}-${3 * MiB + 98}`])
  })

  it('reads each copy apart, and asks again after "Try again"', async () => {
    const block = 256 * 1024
    await artifactRangeFetch(sdk, REPO, manifest('one'))(0, block)
    await artifactRangeFetch(sdk, REPO, manifest('two'))(0, block)
    forgetDeadMirrors()
    await artifactRangeFetch(sdk, REPO, manifest('one'))(0, block)
    expect(asked).toHaveLength(3)
  })

  it('fetches a whole pack from one gateway when it serves', async () => {
    const got = await loadArtifactBytesProgress(sdk, REPO, manifest())
    expect(got.length).toBe(bytes.length)
    expect(asked).toEqual(['a.example whole'])
  })

  it('starts the next gateway only once the first has been silent a while', async () => {
    vi.useFakeTimers()
    silent.add('a.example')
    let done = false
    const pending = loadArtifactBytesProgress(sdk, REPO, manifest()).finally(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(asked).toEqual(['a.example whole'])
    for (let i = 0; i < 100 && !done; i++) await vi.advanceTimersByTimeAsync(250)
    expect((await pending).length).toBe(bytes.length)
    expect(asked).toEqual(['a.example whole', 'b.example whole'])
  })
})
