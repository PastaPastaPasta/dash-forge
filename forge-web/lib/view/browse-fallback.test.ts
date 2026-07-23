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
import { describe, expect, it } from 'vitest'

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
