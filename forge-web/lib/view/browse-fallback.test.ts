/**
 * Fallback-clone orchestrator: against a mock SDK serving platform `chunk` documents, the
 * full flow (download → sha256 verify → index → synthesized locator) yields a working
 * BrowseReader; a hash mismatch fails the run AND evicts the session cache so a retry
 * starts clean.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { zlibSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { gitOidHex } from '../browse'
import {
  T_BLOB,
  T_OFS_DELTA,
  concat,
  copyInsertDelta,
  objHeader,
  ofsBase,
  packFrame,
} from '../browse/pack-fixtures'
import { CHUNK_PAYLOAD_MAX } from '../constants'
import type { PackManifest, RepoRef } from '../repo'
import { base64ToHex, bytesToBase64 } from '../sdk'
import { cachedFallback, startFallback, type FallbackProgress } from './browse-fallback'
import { externalFetchUrls } from './browse-source'
import { contentChecks, resetContentChecks } from './content-checks'
import { deriveTrust } from './trust'

/** Mock SDK serving each pack's bytes as `chunk` docs split at CHUNK_PAYLOAD_MAX. */
function mockSdk(packsByHash: Map<string, Uint8Array>): EvoSDK {
  return {
    documents: {
      query: (q: { where?: readonly (readonly unknown[])[] }): Promise<Map<string, unknown>> => {
        const packClause = (q.where ?? []).find((w) => w[0] === 'packHash')
        const seqClause = (q.where ?? []).find((w) => w[0] === 'seq')
        const bytes = packsByHash.get(base64ToHex(String(packClause?.[2] ?? '')))
        const seqs = (seqClause?.[2] as number[]) ?? []
        const map = new Map<string, unknown>()
        if (bytes === undefined) return Promise.resolve(map)
        for (const seq of seqs) {
          const from = seq * CHUNK_PAYLOAD_MAX
          if (from >= bytes.length) continue
          const to = Math.min(from + CHUNK_PAYLOAD_MAX, bytes.length)
          map.set(`c${seq}`, { seq, d0: bytesToBase64(bytes.subarray(from, to)) })
        }
        return Promise.resolve(map)
      },
    },
  } as unknown as EvoSDK
}

function manifestFor(pack: Uint8Array, objectCount: number, overrides: Partial<PackManifest> = {}): PackManifest {
  return {
    packHash: bytesToHex(sha256(pack)),
    kind: 0,
    sizeBytes: pack.length,
    objectCount,
    chunkCount: Math.ceil(pack.length / CHUNK_PAYLOAD_MAX),
    storage: 0,
    uris: [],
    tips: [],
    supersedes: [],
    createdAt: 1,
    documentId: 'd1',
    ...overrides,
  }
}

/** A pack with a base blob + an OFS_DELTA onto it. */
function fixturePack(): { pack: Uint8Array; baseOid: string; targetOid: string; base: Uint8Array; target: Uint8Array } {
  const base = new TextEncoder().encode('the quick brown fox jumps over the lazy dog\n')
  const target = new TextEncoder().encode('the quick brown fox jumps over the lazy cat\n')
  const baseStored = concat(objHeader(T_BLOB, base.length), zlibSync(base))
  const delta = copyInsertDelta(base.length, target.length, 40, new TextEncoder().encode('cat\n'))
  const deltaStored = concat(objHeader(T_OFS_DELTA, delta.length), ofsBase(baseStored.length), zlibSync(delta))
  return {
    pack: packFrame(baseStored, deltaStored),
    baseOid: gitOidHex('blob', base),
    targetOid: gitOidHex('blob', target),
    base,
    target,
  }
}

describe('startFallback', () => {
  it('downloads, verifies, indexes, and serves objects through the synthesized locator', async () => {
    const { pack, baseOid, targetOid, base, target } = fixturePack()
    const manifest = manifestFor(pack, 2)
    const repo: RepoRef = { contractId: 'fallback-ok', ownerId: 'owner' }
    const sdk = mockSdk(new Map([[manifest.packHash, pack]]))

    const phases: FallbackProgress['phase'][] = []
    const ctx = await startFallback(sdk, repo, [manifest], (p) => phases.push(p.phase))

    expect(phases).toContain('download')
    expect(phases).toContain('index')
    expect(Array.from((await ctx.reader.readObject(baseOid)).bytes)).toEqual(Array.from(base))
    expect(Array.from((await ctx.reader.readObject(targetOid)).bytes)).toEqual(Array.from(target))

    // The session cache holds the completed run; a second start joins it.
    expect(cachedFallback(repo.contractId)).not.toBeNull()
    await expect(startFallback(sdk, repo, [manifest])).resolves.toBe(ctx)
  })

  it('rejects on pack hash mismatch and evicts the cache entry', async () => {
    const { pack } = fixturePack()
    const manifest = manifestFor(pack, 2, { packHash: '00'.repeat(32) })
    const repo: RepoRef = { contractId: 'fallback-badhash', ownerId: 'owner' }
    const sdk = mockSdk(new Map([[manifest.packHash, pack]]))

    await expect(startFallback(sdk, repo, [manifest])).rejects.toThrow(/hash mismatch/)
    await Promise.resolve() // let the eviction handler run
    expect(cachedFallback(repo.contractId)).toBeNull()
  })

  it('rejects when the manifest objectCount disagrees with the pack header', async () => {
    const { pack } = fixturePack()
    const manifest = manifestFor(pack, 5)
    const repo: RepoRef = { contractId: 'fallback-badcount', ownerId: 'owner' }
    const sdk = mockSdk(new Map([[manifest.packHash, pack]]))
    await expect(startFallback(sdk, repo, [manifest])).rejects.toThrow(/header claims/)
  })
})

/** A single-blob pack (no deltas) holding `text`. */
function blobPack(text: string): { pack: Uint8Array; oid: string } {
  const body = new TextEncoder().encode(text)
  return { pack: packFrame(concat(objHeader(T_BLOB, body.length), zlibSync(body))), oid: gitOidHex('blob', body) }
}

/** Route `fetch` by URL: a handler returns bytes, or throws for a dead host. */
function stubFetch(routes: Record<string, () => Uint8Array>): string[] {
  const calls: string[] = []
  vi.stubGlobal('fetch', (url: string) => {
    calls.push(url)
    const route = routes[url]
    if (route === undefined) return Promise.reject(new TypeError('fetch failed: connection refused'))
    const bytes = route()
    return Promise.resolve(new Response(new Blob([bytes as BlobPart]), { status: 200 }))
  })
  return calls
}

describe('startFallback with external-storage packs', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetContentChecks()
  })

  it('skips an external pack no mirror serves, reports it, and still serves the rest', async () => {
    const plat = blobPack('on-chain content\n')
    const ext = blobPack('content only the dead mirror had\n')
    const platform = manifestFor(plat.pack, 1, { createdAt: 1, documentId: 'a' })
    const external = manifestFor(ext.pack, 1, {
      storage: 1,
      chunkCount: 0,
      uris: ['http://127.0.0.1:9000/forge-byo/pack', 's3://forge-byo/pack'],
      createdAt: 2,
      documentId: 'b',
    })
    const repo: RepoRef = { contractId: 'fallback-partial', ownerId: 'owner' }
    const calls = stubFetch({})
    const ctx = await startFallback(mockSdk(new Map([[platform.packHash, plat.pack]])), repo, [platform, external])

    expect(calls).toEqual(['http://127.0.0.1:9000/forge-byo/pack']) // s3:// is not browser-fetchable
    expect(ctx.unavailable).toHaveLength(1)
    expect(ctx.unavailable?.[0]?.packHash).toBe(external.packHash)
    expect(ctx.unavailable?.[0]?.hosts).toEqual(['127.0.0.1:9000'])
    expect(Array.from((await ctx.reader.readObject(plat.oid)).bytes)).toEqual(
      Array.from(new TextEncoder().encode('on-chain content\n')),
    )
    // A needed object from the skipped pack gets a per-view error naming pack and storage.
    await expect(ctx.reader.readObject(ext.oid)).rejects.toThrow(
      new RegExp(`${external.packHash.slice(0, 12)}.*127\\.0\\.0\\.1:9000`),
    )
    // The trust ledger reports the gap: content is partial, never verified.
    const checks = contentChecks(repo.contractId)
    expect(checks.unavailablePacks).toEqual([external.packHash])
    const trust = deriveTrust({
      network: 'testnet',
      connection: 'trusted',
      tip: 'missing',
      checks,
      configuredBackend: 'platform',
    })
    expect(trust.content.state).toBe('partial')
    expect(trust.content.detail).toMatch(/1 pack could not be fetched from its storage; some objects may be missing|could not be fetched/)
  })

  it('reports a pack named by several manifests once', async () => {
    const plat = blobPack('kept\n')
    const ext = blobPack('gone\n')
    const platform = manifestFor(plat.pack, 1, { createdAt: 1, documentId: 'a' })
    const external = (documentId: string): PackManifest =>
      manifestFor(ext.pack, 1, { storage: 1, uris: ['http://127.0.0.1:9000/p'], createdAt: 2, documentId })
    stubFetch({})
    const ctx = await startFallback(
      mockSdk(new Map([[platform.packHash, plat.pack]])),
      { contractId: 'fallback-dup', ownerId: 'owner' },
      [platform, external('b'), external('c')],
    )
    expect(ctx.unavailable).toHaveLength(1)
  })

  it('fetches an ipfs:// pack through a gateway and verifies it', async () => {
    const ext = blobPack('pinned on ipfs\n')
    const external = manifestFor(ext.pack, 1, { storage: 1, chunkCount: 0, uris: ['ipfs://bafkreitest'] })
    const repo: RepoRef = { contractId: 'fallback-ipfs', ownerId: 'owner' }
    const [first, second] = externalFetchUrls(external.uris)
    expect(first).toBe('https://ipfs.io/ipfs/bafkreitest')
    // The first gateway is down; the second serves the right bytes.
    stubFetch({ [second as string]: () => ext.pack })
    const ctx = await startFallback(mockSdk(new Map()), repo, [external])
    expect(ctx.unavailable).toEqual([])
    expect((await ctx.reader.readObject(ext.oid)).type).toBe('blob')
    expect(contentChecks(repo.contractId).sources).toEqual(['dweb.link'])
  })

  it('treats a mirror serving the wrong bytes as unavailable, not as content', async () => {
    const plat = blobPack('real\n')
    const ext = blobPack('expected\n')
    const platform = manifestFor(plat.pack, 1, { createdAt: 1, documentId: 'a' })
    const external = manifestFor(ext.pack, 1, { storage: 1, uris: ['https://mirror.example/p'], createdAt: 2, documentId: 'b' })
    const repo: RepoRef = { contractId: 'fallback-liar', ownerId: 'owner' }
    stubFetch({ 'https://mirror.example/p': () => blobPack('forged!!!\n').pack })
    const ctx = await startFallback(mockSdk(new Map([[platform.packHash, plat.pack]])), repo, [platform, external])
    expect(ctx.unavailable?.[0]?.reason).toMatch(/sha256/)
    await expect(ctx.reader.readObject(ext.oid)).rejects.toThrow(/could not be fetched/)
  })

  it('still fails loudly when an on-chain pack cannot be read', async () => {
    const plat = blobPack('on-chain\n')
    const platform = manifestFor(plat.pack, 1)
    const repo: RepoRef = { contractId: 'fallback-platform-missing', ownerId: 'owner' }
    // The chunk documents are absent: platform storage must not be skipped.
    await expect(startFallback(mockSdk(new Map()), repo, [platform])).rejects.toThrow(/missing chunk/)
  })

  it('fails with the reasons when no live pack at all could be fetched', async () => {
    const ext = blobPack('x\n')
    const external = manifestFor(ext.pack, 1, { storage: 1, uris: ['http://127.0.0.1:9000/p'] })
    stubFetch({})
    await expect(
      startFallback(mockSdk(new Map()), { contractId: 'fallback-none', ownerId: 'owner' }, [external]),
    ).rejects.toThrow(/none of this repo's 1 live packs could be fetched/)
  })
})
