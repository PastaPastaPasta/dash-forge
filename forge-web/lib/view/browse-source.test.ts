/**
 * Browse-source correctness: the two glue assumptions the UI build documented, now pinned
 * by tests (a wrong assumption means wrong bytes when browsing).
 *
 *  (a) packRef → pack ordering is oldest-first by `($createdAt, $id)`, bounded to packs that
 *      existed when the owning locator was published.
 *  (b) offset → seq maps as `⌊offset / CHUNK_PAYLOAD_MAX⌋` because the chunker fills every
 *      interior chunk to exactly `CHUNK_PAYLOAD_MAX` (forge-core `pack.rs::split`).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it } from 'vitest'

import { CHUNK_PAYLOAD_MAX } from '../constants'
import type { PackManifest, RepoRef } from '../repo'
import { base64ToHex, bytesToBase64 } from '../sdk'
import { artifactRangeFetch, buildPackSource, clearChunkCache } from './browse-source'

// These fixtures reuse short fake packHashes ('aa', 'bb') with DIFFERENT bytes per suite —
// impossible in production (packHash = sha256 of the bytes), so the session chunk cache
// must be dropped between tests to keep the fixtures independent.
beforeEach(() => clearChunkCache())

const REPO: RepoRef = { contractId: 'contract', ownerId: 'owner' }

function gitPack(packHashHex: string, createdAt: number, documentId: string): PackManifest {
  return {
    packHash: packHashHex,
    kind: 0,
    sizeBytes: 0,
    objectCount: 0,
    chunkCount: 0,
    storage: 0,
    uris: [],
    tips: [],
    supersedes: [],
    createdAt,
    documentId,
  }
}

/**
 * A mock SDK whose `chunk` query serves one artifact's bytes, split at `CHUNK_PAYLOAD_MAX`.
 * `bytesFor(packHashHex)` supplies the artifact bytes for whichever pack is being read, so a
 * test can assert both which pack was chosen and that the reassembled range is exact.
 */
function mockSdk(bytesFor: (packHashHex: string) => Uint8Array): EvoSDK {
  return {
    documents: {
      query: (q: {
        where?: readonly (readonly unknown[])[]
      }): Promise<Map<string, unknown>> => {
        const packClause = (q.where ?? []).find((w) => w[0] === 'packHash')
        const seqClause = (q.where ?? []).find((w) => w[0] === 'seq')
        const packHashHex = base64ToHex(String(packClause?.[2] ?? ''))
        const seqs = (seqClause?.[2] as number[]) ?? []
        const bytes = bytesFor(packHashHex)
        const map = new Map<string, unknown>()
        for (const seq of seqs) {
          const from = seq * CHUNK_PAYLOAD_MAX
          const to = Math.min(from + CHUNK_PAYLOAD_MAX, bytes.length)
          if (from >= bytes.length) continue
          map.set(`c${seq}`, { seq, d0: bytesToBase64(bytes.subarray(from, to)) })
        }
        return Promise.resolve(map)
      },
    },
  } as unknown as EvoSDK
}

describe('offset → seq mapping (assumption b)', () => {
  // Two full interior chunks + a short tail — the case that exercises the boundary math.
  const total = CHUNK_PAYLOAD_MAX * 2 + 137
  const full = new Uint8Array(total)
  for (let i = 0; i < total; i++) full[i] = i % 251

  const manifest = gitPack('aa', 0, 'd1')
  const fetchRange = () => artifactRangeFetch(mockSdk(() => full), REPO, manifest)

  it('reads a range spanning the seq0 → seq1 boundary exactly', async () => {
    const start = CHUNK_PAYLOAD_MAX - 10
    const end = CHUNK_PAYLOAD_MAX + 10
    const got = await fetchRange()(start, end)
    expect(Array.from(got)).toEqual(Array.from(full.subarray(start, end)))
  })

  it('reads a range spanning the seq1 → seq2 (partial tail) boundary exactly', async () => {
    const start = CHUNK_PAYLOAD_MAX * 2 - 5
    const end = total
    const got = await fetchRange()(start, end)
    expect(Array.from(got)).toEqual(Array.from(full.subarray(start, end)))
  })

  it('reads the whole artifact across all three chunks exactly', async () => {
    const got = await fetchRange()(0, total)
    expect(Array.from(got)).toEqual(Array.from(full))
  })

  it('reads a range wholly inside the interior seq1 chunk exactly', async () => {
    const start = CHUNK_PAYLOAD_MAX + 3
    const end = CHUNK_PAYLOAD_MAX + 50
    const got = await fetchRange()(start, end)
    expect(Array.from(got)).toEqual(Array.from(full.subarray(start, end)))
  })
})

describe('chunk LRU', () => {
  const total = CHUNK_PAYLOAD_MAX * 2 + 64
  const full = new Uint8Array(total)
  for (let i = 0; i < total; i++) full[i] = (i * 31 + 7) % 251

  /** The mock sdk, plus a log of the seq lists each chunk query asked for. */
  function spyingSdk(): { sdk: EvoSDK; calls: number[][] } {
    const inner = mockSdk(() => full) as unknown as {
      documents: { query: (q: unknown) => Promise<Map<string, unknown>> }
    }
    const calls: number[][] = []
    const sdk = {
      documents: {
        query: (q: { where?: readonly (readonly unknown[])[] }): Promise<Map<string, unknown>> => {
          const seqClause = (q.where ?? []).find((w) => w[0] === 'seq')
          calls.push([...((seqClause?.[2] as number[]) ?? [])])
          return inner.documents.query(q)
        },
      },
    } as unknown as EvoSDK
    return { sdk, calls }
  }

  it('re-queries only the seqs missing from the cache and still composes exact bytes', async () => {
    const { sdk, calls } = spyingSdk()
    const fetchRange = artifactRangeFetch(sdk, REPO, gitPack('dd', 0, 'd9'))

    const first = await fetchRange(0, CHUNK_PAYLOAD_MAX + 10) // seqs 0, 1
    expect(Array.from(first)).toEqual(Array.from(full.subarray(0, CHUNK_PAYLOAD_MAX + 10)))
    expect(calls).toEqual([[0, 1]])

    // Overlaps the cached seqs 0–1 and needs seq 2 — only 2 goes to Platform.
    const start = CHUNK_PAYLOAD_MAX - 5
    const second = await fetchRange(start, total)
    expect(Array.from(second)).toEqual(Array.from(full.subarray(start, total)))
    expect(calls).toEqual([[0, 1], [2]])
  })

  it('dedupes concurrent fetches of the same chunk into one query', async () => {
    const { sdk, calls } = spyingSdk()
    const fetchRange = artifactRangeFetch(sdk, REPO, gitPack('ee', 0, 'da'))
    const [a, b] = await Promise.all([fetchRange(0, 10), fetchRange(5, 20)])
    expect(Array.from(a)).toEqual(Array.from(full.subarray(0, 10)))
    expect(Array.from(b)).toEqual(Array.from(full.subarray(5, 20)))
    expect(calls).toEqual([[0]])
  })

  it('does not poison the cache on a failed fetch — the retry re-queries', async () => {
    let fail = true
    const inner = mockSdk(() => full) as unknown as {
      documents: { query: (q: unknown) => Promise<Map<string, unknown>> }
    }
    const sdk = {
      documents: {
        query: (q: unknown): Promise<Map<string, unknown>> =>
          fail ? Promise.reject(new Error('transient')) : inner.documents.query(q),
      },
    } as unknown as EvoSDK
    const fetchRange = artifactRangeFetch(sdk, REPO, gitPack('ff', 0, 'db'))
    await expect(fetchRange(0, 10)).rejects.toThrow('transient')
    fail = false
    expect(Array.from(await fetchRange(0, 10))).toEqual(Array.from(full.subarray(0, 10)))
  })
})

describe('packRef ordering (assumption a)', () => {
  // Each pack's "bytes" are a single identifying byte, so fetchRange(packRef, 0, 1) reveals
  // which manifest packRef resolved to.
  const idByte: Record<string, number> = { aa: 0xa1, bb: 0xb2, cc: 0xc3 }
  const sdk = mockSdk((hex) => new Uint8Array([idByte[hex] ?? 0]))

  it('orders oldest-first by $createdAt (not by query order)', async () => {
    // Given out-of-order manifests (newest-first, as the query returns them):
    const packs = [gitPack('cc', 300, 'z'), gitPack('bb', 200, 'y'), gitPack('aa', 100, 'x')]
    const src = buildPackSource(sdk, REPO, packs)
    expect((await src.fetchRange(0, 0, 1))[0]).toBe(0xa1) // createdAt 100
    expect((await src.fetchRange(1, 0, 1))[0]).toBe(0xb2) // createdAt 200
    expect((await src.fetchRange(2, 0, 1))[0]).toBe(0xc3) // createdAt 300
  })

  it('breaks $createdAt ties by documentId ascending', async () => {
    // Same timestamp, so the $id tiebreak decides order — "x" < "y" < "z".
    const packs = [gitPack('cc', 100, 'z'), gitPack('aa', 100, 'x'), gitPack('bb', 100, 'y')]
    const src = buildPackSource(sdk, REPO, packs)
    expect((await src.fetchRange(0, 0, 1))[0]).toBe(0xa1) // id "x"
    expect((await src.fetchRange(1, 0, 1))[0]).toBe(0xb2) // id "y"
    expect((await src.fetchRange(2, 0, 1))[0]).toBe(0xc3) // id "z"
  })

  it('bounds the packRef space to packs published at/before the locator (asOf)', async () => {
    const packs = [gitPack('aa', 100, 'x'), gitPack('bb', 200, 'y'), gitPack('cc', 300, 'z')]
    const src = buildPackSource(sdk, REPO, packs, 250) // locator published at t=250
    expect((await src.fetchRange(0, 0, 1))[0]).toBe(0xa1)
    expect((await src.fetchRange(1, 0, 1))[0]).toBe(0xb2)
    // The pack pushed after the locator (t=300) is outside its packRef space.
    await expect(src.fetchRange(2, 0, 1)).rejects.toThrow(/out of range/)
  })
})
