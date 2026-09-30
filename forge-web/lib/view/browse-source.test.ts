/**
 * Browse-source correctness: the two glue assumptions the UI build documented, now pinned
 * by tests (a wrong assumption means wrong bytes when browsing).
 *
 *  (a) packRef → pack ordering is oldest-first by first upload `($createdAt, $id)`, bounded
 *      to packs that existed when the owning locator was published (`forge-v2.md` §4).
 *  (b) offset → seq maps as `⌊offset / CHUNK_PAYLOAD_MAX⌋` because the chunker fills every
 *      interior chunk to exactly `CHUNK_PAYLOAD_MAX` (forge-core `pack.rs::split`).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CHUNK_PAYLOAD_MAX } from '../constants'
import type { PackManifest, RepoRef } from '../repo'
import { bytesToBase64 } from '../sdk'
import { base58Decode, base58Encode } from '../auth/base58'
import { DOC, resetForkParents } from '../repo'
import { serializeLocator, type IndexedObject } from '../browse/indexer'
import {
  artifactRangeFetch,
  buildPackSource,
  CHUNK_QUERIES_IN_FLIGHT,
  clearChunkCache,
  loadArtifactBytesProgress,
  loadBrowseContext,
  PackUnavailableError,
  resetExternalFetchState,
} from './browse-source'
import { memoryArtifactStore, setIndexArtifactStore } from './index-cache'

// These fixtures reuse short fake packHashes ('aa', 'bb') with DIFFERENT bytes per suite —
// impossible in production (packHash = sha256 of the bytes), so the session chunk cache
// must be dropped between tests to keep the fixtures independent.
beforeEach(() => clearChunkCache())

const REPO: RepoRef = {
  forge: { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' },
  repoId: 'REPO',
  ownerId: 'owner',
  name: 'proj',
  visibility: 'public',
}

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
    uploader: 'owner',
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
        const packHashHex = bytesToHex(base58Decode(String(packClause?.[2] ?? '')))
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

  it('keeps at most CHUNK_QUERIES_IN_FLIGHT chunk queries out across every pack read at once', async () => {
    const inner = mockSdk(() => full) as unknown as { documents: { query: (q: unknown) => Promise<Map<string, unknown>> } }
    let inFlight = 0
    let peak = 0
    let sent = 0
    const sdk = {
      documents: {
        query: async (q: unknown): Promise<Map<string, unknown>> => {
          sent++
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise((r) => setTimeout(r, 2))
          inFlight--
          return inner.documents.query(q)
        },
      },
    } as unknown as EvoSDK
    // 48 packs (a diff's count pool over several packs), each read at once: 48 separate queries.
    const packs = Array.from({ length: 48 }, (_, i) => gitPack((0x40 + i).toString(16), 0, `p${i}`))
    const got = await Promise.all(packs.map((p) => artifactRangeFetch(sdk, REPO, p)(0, 10)))
    for (const bytes of got) expect(Array.from(bytes)).toEqual(Array.from(full.subarray(0, 10)))
    expect(sent).toBe(48)
    expect(peak).toBe(CHUNK_QUERIES_IN_FLIGHT)
  })
})

// L-15: a 10 MB locator is ~7 windows of 100 chunks; read one after another they were ~2 s of
// serial round trips before the repo home could show anything.
describe('whole-artifact load', () => {
  it('reads its windows several at a time and reassembles them exactly', async () => {
    const total = CHUNK_PAYLOAD_MAX * 100 * 6 + 999
    const full = new Uint8Array(total)
    for (let i = 0; i < total; i++) full[i] = (i * 13 + 5) % 251
    const hash = bytesToHex(sha256(full))
    const inner = mockSdk(() => full) as unknown as { documents: { query: (q: unknown) => Promise<Map<string, unknown>> } }
    let inFlight = 0
    let peak = 0
    const sdk = {
      documents: {
        query: async (q: unknown): Promise<Map<string, unknown>> => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise((r) => setTimeout(r, 5))
          inFlight--
          return inner.documents.query(q)
        },
      },
    } as unknown as EvoSDK
    const progress: number[] = []
    const manifest = { ...gitPack(hash, 0, 'w1'), sizeBytes: total }
    const got = await loadArtifactBytesProgress(sdk, REPO, manifest, (done) => progress.push(done))
    expect(bytesToHex(sha256(got))).toBe(hash)
    expect(peak).toBeGreaterThanOrEqual(4)
    expect(progress[progress.length - 1]).toBe(total)
  })

  /** An artifact of `windows` full 100-chunk windows, and an sdk counting chunk queries. */
  function windowed(windows: number, fail: (seq0: number) => boolean = () => false) {
    const total = CHUNK_PAYLOAD_MAX * 100 * windows
    const full = new Uint8Array(total).fill(7)
    const inner = mockSdk(() => full) as unknown as { documents: { query: (q: { where?: readonly (readonly unknown[])[] }) => Promise<Map<string, unknown>> } }
    let queries = 0
    const sdk = {
      documents: {
        query: async (q: { where?: readonly (readonly unknown[])[] }): Promise<Map<string, unknown>> => {
          queries++
          await new Promise((r) => setTimeout(r, 2))
          const seqs = ((q.where ?? []).find((w) => w[0] === 'seq')?.[2] as number[]) ?? []
          if (fail(seqs[0] ?? 0)) throw new Error('chunk query failed')
          return inner.documents.query(q)
        },
      },
    } as unknown as EvoSDK
    const manifest = { ...gitPack(bytesToHex(sha256(full)), 0, `w${windows}`), sizeBytes: total }
    return { sdk, manifest, queries: () => queries }
  }

  it('stops reading windows once one fails', async () => {
    const w = windowed(12, (seq0) => seq0 === 100)
    const outcome = await loadArtifactBytesProgress(w.sdk, REPO, w.manifest).then(() => 'resolved', (e: unknown) => String(e))
    expect(outcome).toMatch(/chunk query failed/)
    await new Promise((r) => setTimeout(r, 100))
    // The four windows in flight when window 1 failed, and no more of the twelve.
    expect(w.queries()).toBeLessThanOrEqual(5)
  })

  it('stops reading windows once the load is cancelled', async () => {
    const w = windowed(12)
    const cancel = new AbortController()
    const load = loadArtifactBytesProgress(w.sdk, REPO, w.manifest, (done) => {
      if (done > 0) cancel.abort()
    }, cancel.signal)
    expect(await load.then(() => 'resolved', (e: unknown) => String(e))).toMatch(/cancelled/)
    await new Promise((r) => setTimeout(r, 100))
    expect(w.queries()).toBeLessThanOrEqual(8)
  })

  it('does not resolve when cancelled while every window is already in flight', async () => {
    // Three windows, all started at once by the pool: none left to refuse when the abort comes.
    const w = windowed(3)
    const cancel = new AbortController()
    const load = loadArtifactBytesProgress(w.sdk, REPO, w.manifest, undefined, cancel.signal)
    await Promise.resolve()
    cancel.abort()
    expect(await load.then(() => 'resolved', (e: unknown) => String(e))).toMatch(/cancelled/)
  })

  it('does not try the next copy once the load is cancelled', async () => {
    const w = windowed(12)
    const cancel = new AbortController()
    const copies = [
      { ...w.manifest, documentId: 'copy-a' },
      { ...w.manifest, documentId: 'copy-b' },
    ]
    const manifest = { ...w.manifest, copies }
    const load = loadArtifactBytesProgress(w.sdk, REPO, manifest, (done) => {
      if (done > 0) cancel.abort()
    }, cancel.signal)
    expect(await load.then(() => 'resolved', (e: unknown) => String(e))).toMatch(/cancelled/)
    const afterFirst = w.queries()
    await new Promise((r) => setTimeout(r, 100))
    // One copy's windows in flight at the abort, and none of the second copy's.
    expect(w.queries()).toBe(afterFirst)
    expect(w.queries()).toBeLessThanOrEqual(8)
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

  it('keeps superseded packs in place, so a repack never shifts indices', async () => {
    // A Platform-tier repack only consolidates: it writes a superseding pack and deletes
    // nothing (`forge-v2.md` §4). The superseded packs keep their positions, so every older
    // locator's packRefs still mean what they meant; the consolidated pack is appended.
    const consolidated: PackManifest = { ...gitPack('cc', 300, 'z'), supersedes: ['aa', 'bb'] }
    const packs = [gitPack('aa', 100, 'x'), gitPack('bb', 200, 'y'), consolidated]

    const src = buildPackSource(sdk, REPO, packs)

    expect((await src.fetchRange(0, 0, 1))[0]).toBe(0xa1)
    expect((await src.fetchRange(1, 0, 1))[0]).toBe(0xb2)
    expect((await src.fetchRange(2, 0, 1))[0]).toBe(0xc3)
  })

  it('bounds the space as of the locator, so a later repack cannot rewrite an older locator', async () => {
    // A repack published AFTER the locator supersedes packs the locator legitimately
    // indexed; the bound keeps the old locator meaning what it meant when it was written.
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

/**
 * A 32-byte hash as the base58 a manifest is read through (RC1 `packHash` is an identifier):
 * `n` filled (a git pack, whose bytes these tests never fetch), or a hex digest (an index
 * fragment, which the reader sha256-checks against it).
 */
const hashId = (h: number | string): string => base58Encode(typeof h === 'string' ? hexToBytes(h) : new Uint8Array(32).fill(h))

/** The packHash of an artifact: sha256 of its bytes, hex. */
const digest = (bytes: Uint8Array): string => bytesToHex(sha256(bytes))

interface ManifestSpec {
  readonly id: string
  readonly createdAt: number
  readonly kind: 0 | 1
  readonly hash: number | string
  readonly sizeBytes?: number
  readonly objectCount?: number
  readonly supersedes?: readonly number[]
  /** The uploader (`$ownerId`); absent = a non-member's copy. */
  readonly owner?: string
}

function manifestDoc(m: ManifestSpec): Record<string, unknown> {
  const supersedes = m.supersedes ?? []
  const packed = new Uint8Array(supersedes.length * 32)
  supersedes.forEach((h, i) => packed.set(new Uint8Array(32).fill(h), i * 32))
  return {
    $id: m.id,
    $createdAt: m.createdAt,
    ...(m.owner !== undefined ? { $ownerId: m.owner } : {}),
    packHash: hashId(m.hash),
    kind: m.kind,
    sizeBytes: m.sizeBytes ?? 0,
    chunkCount: 1,
    // Kind-0 packs hold objects unless a test says otherwise; coverage exempts empty ones.
    objectCount: m.objectCount ?? (m.kind === 0 ? 2 : 0),
    storage: 0,
    uris: [],
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
 * documents holding each index fragment's bytes — plus the repo's `maintainer` documents,
 * which rank each manifest copy by its uploader's role.
 */
function browseSdk(
  manifests: readonly Record<string, unknown>[],
  artifacts: ReadonlyMap<string, Uint8Array>,
  maintainers: readonly Record<string, unknown>[] = [],
): EvoSDK {
  return {
    documents: {
      query: (q: {
        documentTypeName: string
        where?: readonly (readonly unknown[])[]
        limit?: number
        startAfter?: string
      }): Promise<Map<string, unknown>> => {
        if (q.documentTypeName === 'maintainer') {
          return Promise.resolve(new Map(maintainers.map((d, i) => [`mt${i}`, d])))
        }
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
        const bytes = artifacts.get(bytesToHex(base58Decode(String(packClause?.[2] ?? ''))))
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
    [digest(F0), F0],
    [digest(F1), F1],
  ])
  const pack0: ManifestSpec = { id: 'p0', createdAt: 100, kind: 0, hash: 0xa0 }
  const pack1: ManifestSpec = { id: 'p1', createdAt: 200, kind: 0, hash: 0xa1 }
  const frag0: ManifestSpec = {
    id: 'f0',
    createdAt: 110,
    kind: 1,
    hash: digest(F0),
    sizeBytes: F0.length,
  }
  const frag1: ManifestSpec = {
    id: 'f1',
    createdAt: 210,
    kind: 1,
    hash: digest(F1),
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

  it('reuses verified index fragments from browser storage on the next page load (D-023)', async () => {
    const store = memoryArtifactStore()
    setIndexArtifactStore(store)
    try {
      const sdk = browseSdk([pack0, pack1, frag0, frag1].map(manifestDoc), artifacts)
      const chunkQueries = (): number =>
        vi.mocked(sdk.documents.query).mock.calls.filter(([q]) => (q as { documentTypeName: string }).documentTypeName === DOC.chunk).length
      vi.spyOn(sdk.documents, 'query')
      expect((await loadBrowseContext(sdk, REPO)).kind).toBe('ready')
      expect(chunkQueries()).toBe(2)
      expect(store.entries.size).toBe(2)

      // A new page load: the session chunk cache is gone, IndexedDB is not.
      clearChunkCache()
      vi.mocked(sdk.documents.query).mockClear()
      const again = await loadBrowseContext(sdk, REPO)
      expect(again.kind).toBe('ready')
      expect(chunkQueries()).toBe(0)
      if (again.kind === 'ready') expect(again.context.locator.lookup(oidBytes(0x24))).toMatchObject({ packRef: 1 })

      // A stored copy that no longer hashes to its manifest is a miss, re-downloaded.
      const [key] = [...store.entries.keys()]
      store.entries.set(key as string, new Uint8Array([1, 2, 3]))
      clearChunkCache()
      vi.mocked(sdk.documents.query).mockClear()
      expect((await loadBrowseContext(sdk, REPO)).kind).toBe('ready')
      expect(chunkQueries()).toBe(1)
    } finally {
      setIndexArtifactStore(null)
    }
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

  it('reports index-behind when a pack pushed after the fragments is not covered', async () => {
    // A repack appends its consolidated pack at the end of the space (superseded packs stay
    // in place), so fragments that predate it cover only a prefix: the new pack is unindexed.
    const consolidated: ManifestSpec = {
      id: 'p2',
      createdAt: 300,
      kind: 0,
      hash: 0xa2,
      supersedes: [0xa0, 0xa1],
    }
    const sdk = browseSdk([pack0, pack1, consolidated, frag0, frag1].map(manifestDoc), artifacts)
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
      hash: digest(wild),
      sizeBytes: wild.length,
    }
    const withWild = new Map(artifacts)
    withWild.set(digest(wild), wild)
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
    partial.delete(digest(F1))
    const sdk = browseSdk([pack0, pack1, frag0, frag1].map(manifestDoc), partial)
    expect(await loadBrowseContext(sdk, REPO)).toMatchObject({
      kind: 'unindexed',
      reason: 'index-behind',
    })
  })

  it('falls back rather than erroring when a fragment is malformed', async () => {
    // Bytes that hash to the manifest's packHash but do not parse as a locator.
    const junk = new Uint8Array(17)
    const corrupt = new Map(artifacts)
    corrupt.set(digest(junk), junk)
    const badFrag1: ManifestSpec = { ...frag1, hash: digest(junk), sizeBytes: junk.length }
    const sdk = browseSdk([pack0, pack1, frag0, badFrag1].map(manifestDoc), corrupt)
    expect(await loadBrowseContext(sdk, REPO)).toMatchObject({
      kind: 'unindexed',
      reason: 'index-behind',
    })
  })

  it('reports no-packs when nothing is stored', async () => {
    expect(await loadBrowseContext(browseSdk([], artifacts), REPO)).toEqual({ kind: 'no-packs' })
  })

  it("reports index-behind when a maintainer's copy re-kinds a pack a fragment indexed", async () => {
    // A since-revoked member uploaded pack0 as a git pack (kind 0), and the fragments were
    // built over it. A maintainer later posts a kind-1 copy of the same hash: that copy now
    // ranks first, so the pack's kind is 1 and it leaves the live git-pack space. As of each
    // fragment the old space still starts with pack0, so the prefix check must refuse the
    // index rather than let packRef 0 read the wrong pack. (Each run uses its own repo id:
    // membership is cached per repo.)
    const MAINT = 'maint'
    const revoked = { ...pack0, owner: 'revoked' }
    const pack1m = { ...pack1, owner: MAINT }
    const frags = [frag0, frag1].map((f) => ({ ...f, owner: MAINT }))
    const members = [{ $id: 'm1', $createdAt: 1, memberId: MAINT }]

    // Control: without the maintainer's copy the index covers both packs.
    const before = [revoked, pack1m, ...frags].map(manifestDoc)
    const ok = await loadBrowseContext(browseSdk(before, artifacts, members), { ...REPO, repoId: 'REKIND-OK' })
    expect(ok.kind).toBe('ready')

    const rekind: ManifestSpec = { id: 'k0', createdAt: 300, kind: 1, hash: 0xa0, owner: MAINT }
    const after = [...before, manifestDoc(rekind)]
    expect(await loadBrowseContext(browseSdk(after, artifacts, members), { ...REPO, repoId: 'REKIND' })).toMatchObject({
      kind: 'unindexed',
      reason: 'index-behind',
    })
  })
})

// ---------------------------------------------------------------------------
// A fork's browse index — its parent's, remapped into the fork's pack space (QW-023)
// ---------------------------------------------------------------------------

describe('loadBrowseContext for a fork (QW-023)', () => {
  beforeEach(() => resetForkParents())

  const parentRepo = (repoId: string): RepoRef => ({ ...REPO, repoId })
  const forkRepo = (repoId: string): RepoRef => ({ ...REPO, repoId, ownerId: 'forker', name: 'proj-fork' })

  /**
   * Two repositories: each `packManifest` query answers the manifests of the repo its `repoId`
   * clause names, a `repo` query by `$id` answers that repo's document (`forkOf` included), and
   * a `chunk` query serves any artifact's bytes.
   */
  function forkSdk(
    manifests: Readonly<Record<string, readonly ManifestSpec[]>>,
    forkOf: Readonly<Record<string, string | null>>,
    artifacts: ReadonlyMap<string, Uint8Array>,
  ): EvoSDK {
    const clause = (q: { where?: readonly (readonly unknown[])[] }, field: string): unknown => (q.where ?? []).find((w) => w[0] === field)?.[2]
    return {
      documents: {
        query: vi.fn((q: { documentTypeName: string; where?: readonly (readonly unknown[])[] }): Promise<Map<string, unknown>> => {
          if (q.documentTypeName === DOC.repo) {
            const id = String(clause(q, '$id'))
            if (!(id in forkOf)) return Promise.resolve(new Map())
            const parent = forkOf[id]
            const doc = { $id: id, $ownerId: 'owner', name: id.toLowerCase(), ...(parent ? { forkOf: parent } : {}) }
            return Promise.resolve(new Map([[id, doc]]))
          }
          if (q.documentTypeName === DOC.packManifest) {
            const rows = (manifests[String(clause(q, 'repoId'))] ?? []).map(manifestDoc)
            return Promise.resolve(new Map(rows.map((d) => [String(d['$id']), d])))
          }
          if (q.documentTypeName === DOC.chunk) {
            const bytes = artifacts.get(bytesToHex(base58Decode(String(clause(q, 'packHash') ?? ''))))
            return Promise.resolve(bytes === undefined ? new Map() : new Map([['c0', { seq: 0, d0: bytesToBase64(bytes) }]]))
          }
          return Promise.resolve(new Map())
        }),
      },
    } as unknown as EvoSDK
  }

  // The parent: three pushes, each indexed. The fork was made after the first two.
  const F0 = fragmentBytes(0, [0x11, 0x13])
  const F1 = fragmentBytes(1, [0x22])
  const F2 = fragmentBytes(2, [0x33])
  const artifacts = new Map([F0, F1, F2].map((f) => [digest(f), f]))
  const frag = (id: string, createdAt: number, bytes: Uint8Array): ManifestSpec => ({ id, createdAt, kind: 1, hash: digest(bytes), sizeBytes: bytes.length })
  const parentManifests: ManifestSpec[] = [
    { id: 'pp0', createdAt: 100, kind: 0, hash: 0xa0 },
    frag('pf0', 110, F0),
    { id: 'pp1', createdAt: 200, kind: 0, hash: 0xa1 },
    frag('pf1', 210, F1),
    { id: 'pp2', createdAt: 300, kind: 0, hash: 0xa2 },
    frag('pf2', 310, F2),
  ]
  // The fork's by-reference manifests, listed in the other order: its packRef 0 is the parent's 1.
  const forkPacks: ManifestSpec[] = [
    { id: 'fp1', createdAt: 1000, kind: 0, hash: 0xa1 },
    { id: 'fp0', createdAt: 1001, kind: 0, hash: 0xa0 },
  ]

  it("reads through its parent's index, remapped to its own packs, instead of a browser rebuild", async () => {
    const sdk = forkSdk({ PARENT1: parentManifests, FORK1: forkPacks }, { FORK1: 'PARENT1', PARENT1: null }, artifacts)
    const state = await loadBrowseContext(sdk, forkRepo('FORK1'))

    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    const { locator } = state.context
    expect(locator.lookup(oidBytes(0x11))).toMatchObject({ packRef: 1, offset: 100 + 0x11 })
    expect(locator.lookup(oidBytes(0x22))).toMatchObject({ packRef: 0, offset: 100 + 0x22 })
    // Pushed to the parent after the fork: not the fork's, so it does not resolve.
    expect(locator.lookup(oidBytes(0x33))).toBeNull()
    expect([...locator.packRefsCovered()].sort()).toEqual([0, 1])
  })

  it("merges the fork's own pushes' fragments with its parent's", async () => {
    // The fork's first push stored pack a9 (its packRef 2) and indexed just that pack.
    const own = fragmentBytes(2, [0x99])
    const withOwn = new Map(artifacts).set(digest(own), own)
    const fork = [...forkPacks, { id: 'fp9', createdAt: 2000, kind: 0 as const, hash: 0xa9 }, frag('ff9', 2010, own)]
    const sdk = forkSdk({ PARENT2: parentManifests, FORK2: fork }, { FORK2: 'PARENT2', PARENT2: null }, withOwn)
    const state = await loadBrowseContext(sdk, forkRepo('FORK2'))

    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.context.locator.lookup(oidBytes(0x99))).toMatchObject({ packRef: 2 })
    expect(state.context.locator.lookup(oidBytes(0x13))).toMatchObject({ packRef: 1 })
  })

  it("reads a fork of a fork through its grandparent's index and its parent's own push", async () => {
    // B forked A and pushed pack a9 (indexed by B at its packRef 2); C forked B.
    const own = fragmentBytes(2, [0x99])
    const withOwn = new Map(artifacts).set(digest(own), own)
    const b = [...forkPacks, { id: 'bp9', createdAt: 2000, kind: 0 as const, hash: 0xa9 }, frag('bf9', 2010, own)]
    const c: ManifestSpec[] = [
      { id: 'cp9', createdAt: 3000, kind: 0, hash: 0xa9 },
      { id: 'cp0', createdAt: 3001, kind: 0, hash: 0xa0 },
      { id: 'cp1', createdAt: 3002, kind: 0, hash: 0xa1 },
    ]
    const sdk = forkSdk({ PARENT6: parentManifests, B6: b, C6: c }, { C6: 'B6', B6: 'PARENT6', PARENT6: null }, withOwn)
    const state = await loadBrowseContext(sdk, forkRepo('C6'))

    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.context.locator.lookup(oidBytes(0x99))).toMatchObject({ packRef: 0 })
    expect(state.context.locator.lookup(oidBytes(0x11))).toMatchObject({ packRef: 1 })
    expect(state.context.locator.lookup(oidBytes(0x22))).toMatchObject({ packRef: 2 })
  })

  it('asks again for a fork whose repo document a lagging node did not return', async () => {
    let lagging = true
    const base = forkSdk({ PARENT7: parentManifests, FORK7: forkPacks }, { FORK7: 'PARENT7', PARENT7: null }, artifacts)
    const query = base.documents.query.bind(base.documents)
    const sdk = {
      documents: {
        query: (q: { documentTypeName: string }) => (lagging && q.documentTypeName === DOC.repo ? Promise.resolve(new Map()) : query(q as never)),
      },
    } as unknown as EvoSDK
    expect(await loadBrowseContext(sdk, forkRepo('FORK7'))).toMatchObject({ kind: 'unindexed', reason: 'no-index' })
    lagging = false
    expect((await loadBrowseContext(sdk, forkRepo('FORK7'))).kind).toBe('ready')
  })

  it('still falls back when the parent published no index, or its index does not cover the fork', async () => {
    const unindexed = parentManifests.filter((m) => m.kind === 0)
    const none = forkSdk({ PARENT3: unindexed, FORK3: forkPacks }, { FORK3: 'PARENT3', PARENT3: null }, artifacts)
    expect(await loadBrowseContext(none, forkRepo('FORK3'))).toMatchObject({ kind: 'unindexed', reason: 'no-index' })

    // The parent indexed only its first push: the fork's second pack stays unindexed.
    const partial = parentManifests.filter((m) => m.id !== 'pf1')
    const behind = forkSdk({ PARENT4: partial, FORK4: forkPacks }, { FORK4: 'PARENT4', PARENT4: null }, artifacts)
    expect(await loadBrowseContext(behind, forkRepo('FORK4'))).toMatchObject({ kind: 'unindexed', reason: 'index-behind' })
  })

  it("never reads another repository's index for a repo that is not a fork", async () => {
    const sdk = forkSdk({ PARENT5: parentManifests, SOLO5: forkPacks }, { SOLO5: null, PARENT5: null }, artifacts)
    expect(await loadBrowseContext(sdk, parentRepo('SOLO5'))).toMatchObject({ kind: 'unindexed', reason: 'no-index' })
    const reads = vi.mocked(sdk.documents.query).mock.calls.map(([q]) => q as { documentTypeName: string; where?: unknown[][] })
    expect(reads.some((q) => q.documentTypeName === DOC.packManifest && q.where?.some((w) => w[1] === '==' && w[2] === 'PARENT5'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Fork packs — `platform://` locators into the parent's chunk scope
// ---------------------------------------------------------------------------

describe('fork pack via a platform:// locator', () => {
  const FORK: RepoRef = {
    forge: { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' },
    repoId: 'FORK',
    ownerId: 'forker',
    name: 'proj',
    visibility: 'public',
  }
  const total = CHUNK_PAYLOAD_MAX + 321
  const bytes = new Uint8Array(total)
  for (let i = 0; i < total; i++) bytes[i] = (i * 17 + 3) % 251
  const hash = bytesToHex(sha256(bytes))

  /** A fork's manifest: no chunks of its own, the parent's copy named by locator. */
  const forkManifest = (uri: string): PackManifest => ({
    ...gitPack(hash, 0, 'fm'),
    sizeBytes: total,
    storage: 1,
    uris: [uri],
    uploader: 'forker',
  })

  /** Chunks exist only in the parent's scope, for the parent-side uploader. */
  function parentSdk(served: Uint8Array): { sdk: EvoSDK; scopes: string[] } {
    const inner = mockSdk(() => served) as unknown as {
      documents: { query: (q: unknown) => Promise<Map<string, unknown>> }
    }
    const scopes: string[] = []
    const sdk = {
      documents: {
        query: (q: { dataContractId: string; where?: readonly (readonly unknown[])[] }) => {
          const field = (f: string): string => String((q.where ?? []).find((w) => w[0] === f)?.[2])
          const scope = `${q.dataContractId}/${field('repoId')}/${field('$ownerId')}`
          scopes.push(scope)
          return scope === 'CORE/PARENT/uploader' ? inner.documents.query(q) : Promise.resolve(new Map())
        },
      },
    } as unknown as EvoSDK
    return { sdk, scopes }
  }

  it("reads the parent scope's chunks and verifies them against packHash", async () => {
    const { sdk, scopes } = parentSdk(bytes)
    const manifest = forkManifest(`platform://CORE/PARENT/uploader/${hash}`)
    const got = await loadArtifactBytesProgress(sdk, FORK, manifest)
    expect(bytesToHex(sha256(got))).toBe(hash)
    expect(new Set(scopes)).toEqual(new Set(['CORE/PARENT/uploader']))
    // Ranged reads (the indexed browse path) follow the same locator.
    const [start, end] = [CHUNK_PAYLOAD_MAX - 4, CHUNK_PAYLOAD_MAX + 4]
    const range = await artifactRangeFetch(sdk, FORK, manifest)(start, end)
    expect(Array.from(range)).toEqual(Array.from(bytes.subarray(start, end)))
  })

  it('rejects chunks that do not hash to the pack', async () => {
    const tampered = bytes.slice()
    tampered[CHUNK_PAYLOAD_MAX + 1]! ^= 0xff
    const { sdk } = parentSdk(tampered)
    const read = loadArtifactBytesProgress(sdk, FORK, forkManifest(`platform://CORE/PARENT/uploader/${hash}`))
    await expect(read).rejects.toBeInstanceOf(PackUnavailableError)
    await expect(read).rejects.toMatchObject({ corrupt: true })
  })

  it.each([
    ["another network's forge-core", `platform://OTHER/PARENT/uploader/${hash}`],
    ['a short form', `platform://CORE/${hash}`],
    ['another pack', `platform://CORE/PARENT/uploader/${'0'.repeat(64)}`],
  ])('skips a locator into %s', async (_what, uri) => {
    const { sdk, scopes } = parentSdk(bytes)
    const read = loadArtifactBytesProgress(sdk, FORK, forkManifest(uri))
    await expect(read).rejects.toBeInstanceOf(PackUnavailableError)
    expect(scopes).toEqual([])
  })

  it("shares cached chunks with the parent's own storage-0 copy", async () => {
    const { sdk, scopes } = parentSdk(bytes)
    const [start, end] = [CHUNK_PAYLOAD_MAX - 4, CHUNK_PAYLOAD_MAX + 4]
    const viaFork = await artifactRangeFetch(sdk, FORK, forkManifest(`platform://CORE/PARENT/uploader/${hash}`))(start, end)
    const queries = scopes.length
    expect(queries).toBeGreaterThan(0)
    // The parent reads the same pack from its own chunks: same network, repo id, uploader, hash.
    const PARENT: RepoRef = { ...FORK, repoId: 'PARENT', ownerId: 'uploader' }
    const own: PackManifest = { ...gitPack(hash, 0, 'pm'), sizeBytes: total, uploader: 'uploader' }
    const viaParent = await artifactRangeFetch(sdk, PARENT, own)(start, end)
    expect(Array.from(viaParent)).toEqual(Array.from(viaFork))
    expect(scopes).toHaveLength(queries) // no second chunk query
  })

  it('falls back to an https mirror when the chunks do not verify', async () => {
    const tampered = bytes.slice()
    tampered[0]! ^= 0xff
    const { sdk } = parentSdk(tampered)
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(bytes.slice())))
    try {
      const manifest = {
        ...forkManifest(`platform://CORE/PARENT/uploader/${hash}`),
        uris: [`platform://CORE/PARENT/uploader/${hash}`, 'https://mirror.example/pack'],
      }
      const got = await loadArtifactBytesProgress(sdk, FORK, manifest)
      expect(bytesToHex(sha256(got))).toBe(hash)
    } finally {
      vi.unstubAllGlobals()
      resetExternalFetchState()
    }
  })
})
