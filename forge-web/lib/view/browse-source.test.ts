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
import { DOC } from '../repo'
import { serializeLocator, type IndexedObject } from '../browse/indexer'
import {
  artifactRangeFetch,
  buildPackSource,
  clearChunkCache,
  loadBrowseContext,
} from './browse-source'

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

  it('excludes superseded packs, so a surviving repacked-over manifest cannot shift indices', async () => {
    // `repack` consolidates packs and marks the originals `supersedes`, but deletes only the
    // CALLER's own manifests — in a multi-author repo the others survive. Counting them
    // would shift every packRef by however many happened to remain, which is incidental to
    // who ran the repack. `cc` here is the consolidated pack; `aa` and `bb` are superseded
    // but still present.
    const consolidated: PackManifest = { ...gitPack('cc', 300, 'z'), supersedes: ['aa', 'bb'] }
    const packs = [gitPack('aa', 100, 'x'), gitPack('bb', 200, 'y'), consolidated]

    const src = buildPackSource(sdk, REPO, packs)

    expect((await src.fetchRange(0, 0, 1))[0]).toBe(0xc3) // the consolidated pack IS packRef 0
    await expect(src.fetchRange(1, 0, 1)).rejects.toThrow(/out of range/)
  })

  it('computes liveness within the asOf bound, so a later repack cannot rewrite an older locator', async () => {
    // A repack published AFTER the locator supersedes packs the locator legitimately
    // indexed. Bounding first and computing liveness second keeps the old locator meaning
    // what it meant when it was written.
    const laterRepack: PackManifest = { ...gitPack('cc', 500, 'z'), supersedes: ['aa', 'bb'] }
    const packs = [gitPack('aa', 100, 'x'), gitPack('bb', 200, 'y'), laterRepack]

    const src = buildPackSource(sdk, REPO, packs, 250) // locator published at t=250

    expect((await src.fetchRange(0, 0, 1))[0]).toBe(0xa1)
    expect((await src.fetchRange(1, 0, 1))[0]).toBe(0xb2)
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

// ---------------------------------------------------------------------------
// loadBrowseContext — index fragments, coverage, and the honest degraded state
// ---------------------------------------------------------------------------

/** A 32-byte hash as the pair of encodings a manifest is read through. */
const hashB64 = (n: number): string => bytesToBase64(new Uint8Array(32).fill(n))

interface ManifestSpec {
  readonly id: string
  readonly createdAt: number
  readonly kind: 0 | 1
  readonly hash: number
  readonly sizeBytes?: number
  readonly objectCount?: number
  readonly supersedes?: readonly number[]
}

function manifestDoc(m: ManifestSpec): Record<string, unknown> {
  const supersedes = m.supersedes ?? []
  const packed = new Uint8Array(supersedes.length * 32)
  supersedes.forEach((h, i) => packed.set(new Uint8Array(32).fill(h), i * 32))
  return {
    $id: m.id,
    $createdAt: m.createdAt,
    packHash: hashB64(m.hash),
    kind: m.kind,
    sizeBytes: m.sizeBytes ?? 0,
    chunkCount: 1,
    // Kind-0 packs hold objects unless a test says otherwise; coverage exempts empty ones.
    objectCount: m.objectCount ?? (m.kind === 0 ? 2 : 0),
    storage: 0,
    uris: '[]',
    tips: '',
    supersedes: supersedes.length > 0 ? bytesToBase64(packed) : '',
  }
}

/** An index fragment over `packRef`, as the bytes a reader would download. */
function fragmentBytes(packRef: number, oids: readonly number[]): Uint8Array {
  const rows: IndexedObject[] = oids.map((n) => ({
    oidHex: n.toString(16).padStart(40, '0'),
    packRef,
    offset: 100 + n,
    length: 10,
    deltaDepth: 0,
  }))
  return serializeLocator(rows)
}

const oidBytes = (n: number): Uint8Array =>
  Uint8Array.from(
    (n.toString(16).padStart(40, '0').match(/../g) ?? []).map((b) => parseInt(b, 16)),
  )

/**
 * A mock serving both halves of a browse resolve: the `packManifest` listing (with the
 * `$createdAt desc` order, page cap and cursor a real query applies) and the `chunk`
 * documents holding each index fragment's bytes.
 */
function browseSdk(
  manifests: readonly Record<string, unknown>[],
  artifacts: ReadonlyMap<string, Uint8Array>,
): EvoSDK {
  return {
    documents: {
      query: (q: {
        documentTypeName: string
        where?: readonly (readonly unknown[])[]
        limit?: number
        startAfter?: string
      }): Promise<Map<string, unknown>> => {
        if (q.documentTypeName === DOC.packManifest) {
          let rows = [...manifests].sort((a, b) => {
            const d = (b['$createdAt'] as number) - (a['$createdAt'] as number)
            return d !== 0 ? d : String(b['$id']).localeCompare(String(a['$id']))
          })
          if (q.startAfter !== undefined) {
            const at = rows.findIndex((d) => d['$id'] === q.startAfter)
            rows = at < 0 ? [] : rows.slice(at + 1)
          }
          rows = rows.slice(0, Math.min(q.limit ?? 100, 100))
          return Promise.resolve(new Map(rows.map((d) => [String(d['$id']), d])))
        }
        // chunk: one document per artifact (every fixture fits in a single chunk).
        const packClause = (q.where ?? []).find((w) => w[0] === 'packHash')
        const bytes = artifacts.get(base64ToHex(String(packClause?.[2] ?? '')))
        if (bytes === undefined) return Promise.resolve(new Map())
        return Promise.resolve(new Map([['c0', { seq: 0, d0: bytesToBase64(bytes) }]]))
      },
    },
  } as unknown as EvoSDK
}

describe('loadBrowseContext', () => {
  // Two packs and one index fragment per pack — the shape a repo has after two pushes.
  const F0 = fragmentBytes(0, [0x11, 0x13])
  const F1 = fragmentBytes(1, [0x22, 0x24])
  const artifacts = new Map([
    ['b0'.repeat(32).slice(0, 64), F0],
    ['b1'.repeat(32).slice(0, 64), F1],
  ])
  const pack0: ManifestSpec = { id: 'p0', createdAt: 100, kind: 0, hash: 0xa0 }
  const pack1: ManifestSpec = { id: 'p1', createdAt: 200, kind: 0, hash: 0xa1 }
  const frag0: ManifestSpec = {
    id: 'f0',
    createdAt: 110,
    kind: 1,
    hash: 0xb0,
    sizeBytes: F0.length,
  }
  const frag1: ManifestSpec = {
    id: 'f1',
    createdAt: 210,
    kind: 1,
    hash: 0xb1,
    sizeBytes: F1.length,
  }

  it('merges the live fragments and serves reads when they cover every live pack', async () => {
    const sdk = browseSdk([pack0, pack1, frag0, frag1].map(manifestDoc), artifacts)
    const state = await loadBrowseContext(sdk, REPO)

    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    // Objects from BOTH pushes resolve, each against its own pack.
    expect(state.context.locator.lookup(oidBytes(0x11))).toMatchObject({ packRef: 0 })
    expect(state.context.locator.lookup(oidBytes(0x24))).toMatchObject({ packRef: 1 })
  })

  it('reports index-behind when a live pack has no fragment covering it', async () => {
    // The regression this exists for: with only the first push indexed, the old reader
    // reported `ready` and then threw `object not in locator` on anything pushed since.
    const sdk = browseSdk([pack0, pack1, frag0].map(manifestDoc), artifacts)
    const state = await loadBrowseContext(sdk, REPO)

    expect(state).toMatchObject({ kind: 'unindexed', reason: 'index-behind' })
    if (state.kind !== 'unindexed') return
    expect(state.livePacks.map((m) => m.documentId)).toEqual(['p0', 'p1'])
  })

  it('reports no-index when nothing has been published', async () => {
    const sdk = browseSdk([pack0, pack1].map(manifestDoc), artifacts)
    expect(await loadBrowseContext(sdk, REPO)).toMatchObject({
      kind: 'unindexed',
      reason: 'no-index',
    })
  })

  it('reports index-behind when a fragment predates a repack that renumbered the packs', async () => {
    // A fragment published concurrently with a repack survives (the repack could not list
    // it in `supersedes`), but it indexes a pack space the repack replaced — its packRefs
    // now name the wrong packs. Caught from the manifest list, before any bytes are read.
    const consolidated: ManifestSpec = {
      id: 'p2',
      createdAt: 300,
      kind: 0,
      hash: 0xa2,
      supersedes: [0xa0, 0xa1],
    }
    const sdk = browseSdk([pack0, pack1, consolidated, frag1].map(manifestDoc), artifacts)
    expect(await loadBrowseContext(sdk, REPO)).toMatchObject({
      kind: 'unindexed',
      reason: 'index-behind',
    })
  })

  it('reports index-behind when a surviving fragment covers the right INDEX of the wrong pack', async () => {
    // The dangerous shape a coverage count alone cannot see. After a repack the live space
    // is one pack, and a fragment that predates it also indexes exactly one pack — index 0
    // in both — so coverage looks complete. But its packRef 0 means the pre-repack pack,
    // and reading through it would return a valid offset in the WRONG pack. Only comparing
    // the fragment's as-of space against the live one catches it.
    const consolidated: ManifestSpec = {
      id: 'p2',
      createdAt: 300,
      kind: 0,
      hash: 0xa2,
      supersedes: [0xa0, 0xa1],
    }
    // frag0 (createdAt 110) indexed packRef 0 when that meant pack0.
    const sdk = browseSdk([pack0, pack1, consolidated, frag0].map(manifestDoc), artifacts)
    expect(await loadBrowseContext(sdk, REPO)).toMatchObject({
      kind: 'unindexed',
      reason: 'index-behind',
    })
  })

  it('does not demand coverage for a pack that holds no objects', async () => {
    // An older client stored an empty pack (a branch or tag pushed at an already-stored
    // commit). It contributes no rows, so its packRef can never appear in the coverage set;
    // requiring it would pin the repo to the fallback clone forever.
    const empty: ManifestSpec = { id: 'p1', createdAt: 200, kind: 0, hash: 0xa1, objectCount: 0 }
    const sdk = browseSdk([pack0, empty, frag0].map(manifestDoc), artifacts)
    expect((await loadBrowseContext(sdk, REPO)).kind).toBe('ready')
  })

  it('reports index-behind when a fragment addresses a pack outside the live set', async () => {
    // Coverage can be complete while a fragment still names a pack that does not exist —
    // it was built over a longer space. The rows would resolve to nothing; only a bounds
    // check on the packRefs sees it.
    const wild = fragmentBytes(5, [0x99])
    const wildManifest: ManifestSpec = {
      id: 'f9',
      createdAt: 220,
      kind: 1,
      hash: 0xb9,
      sizeBytes: wild.length,
    }
    const withWild = new Map(artifacts)
    withWild.set('b9'.repeat(32).slice(0, 64), wild)
    const sdk = browseSdk([pack0, pack1, frag0, frag1, wildManifest].map(manifestDoc), withWild)
    expect(await loadBrowseContext(sdk, REPO)).toMatchObject({
      kind: 'unindexed',
      reason: 'index-behind',
    })
  })

  it('falls back rather than erroring when a fragment cannot be loaded', async () => {
    // One transient chunk-query failure out of up to 16 fragment fetches must not deny the
    // user a repo whose raw packs are perfectly readable.
    const partial = new Map(artifacts)
    partial.delete('b1'.repeat(32).slice(0, 64))
    const sdk = browseSdk([pack0, pack1, frag0, frag1].map(manifestDoc), partial)
    expect(await loadBrowseContext(sdk, REPO)).toMatchObject({
      kind: 'unindexed',
      reason: 'index-behind',
    })
  })

  it('falls back rather than erroring when a fragment is malformed', async () => {
    const corrupt = new Map(artifacts)
    corrupt.set('b1'.repeat(32).slice(0, 64), new Uint8Array(17))
    const sdk = browseSdk([pack0, pack1, frag0, frag1].map(manifestDoc), corrupt)
    expect(await loadBrowseContext(sdk, REPO)).toMatchObject({
      kind: 'unindexed',
      reason: 'index-behind',
    })
  })

  it('reports no-packs when nothing is stored', async () => {
    expect(await loadBrowseContext(browseSdk([], artifacts), REPO)).toEqual({ kind: 'no-packs' })
  })
})
