/**
 * QW3-001: the browse index's request and byte budget on a dash-sized repo. dashpay/dash on
 * bonsia (2026-09-30) is one 271 MB pack of 268,052 objects with one index fragment of 9.65 MB
 * (657 chunk documents, about 12.6 MB on the wire with their proofs). Every cold visit to any of
 * its code pages downloaded all of it before showing a file: 118-160 s on that day's devnet.
 *
 * Now the fragment is read a chunk at a time: the resolve reads its fanout (one chunk), and a
 * page the chunks holding the rows of the objects it shows (usually one each). Pinned here, cold
 * and warm, against a mock serving that exact shape.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { base58Decode, base58Encode } from '../auth/base58'
import { serializeLocator } from '../browse/indexer'
import { CHUNK_PAYLOAD_MAX } from '../constants'
import { DOC, type RepoRef } from '../repo'
import { bytesToBase64 } from '../sdk'
import { clearChunkCache, loadBrowseContext, resetBrowseCache } from './browse-source'
import { memoryArtifactStore, setIndexArtifactStore } from './index-cache'

/** dashpay/dash's index on bonsia: its rows, and so its 9,650,896 bytes in 657 chunks. */
const DASH_OBJECTS = 268_052
/** A cold resolve reads the index's fanout: its first chunk, in one query. */
const RESOLVE_CHUNKS = 1
/**
 * A lookup reads the chunk where its OID's row should be (its fanout slice, 268,052 / 256 rows of
 * 36 bytes, is about 37.7 KB: 3 or 4 chunks of 14,700 bytes), and the next one when that is near
 * its edge.
 */
const LOOKUP_CHUNKS_MAX = 2
/** The objects a cold dash home reads by OID, one after the other: the tip commit, its root tree, the README. */
const HOME_SERIAL = 3
/** Then a list's rows side by side: the branch list's tips (the home's own commit column is the history index). */
const LIST_LOOKUPS = 30
const HOME_LOOKUPS = HOME_SERIAL + LIST_LOOKUPS

const REPO: RepoRef = {
  forge: { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' },
  repoId: 'DASH',
  ownerId: 'owner',
  name: 'dash',
  visibility: 'public',
}

const oidOf = (n: number): string => bytesToHex(sha256(new TextEncoder().encode(`dash object ${n}`))).slice(0, 40)

const INDEX = serializeLocator(Array.from({ length: DASH_OBJECTS }, (_, i) => ({ oidHex: oidOf(i), packRef: 0, offset: 12 + i * 1000, length: 900, deltaDepth: 0 })))
const INDEX_HASH = bytesToHex(sha256(INDEX))
const INDEX_CHUNKS = Math.ceil(INDEX.length / CHUNK_PAYLOAD_MAX)

/** A push after the import: its pack's objects, and whether its own index fragment landed. */
interface LaterPush {
  readonly objects: number
  readonly fragment: boolean
}

/** The fragment a later push publishes: its pack's rows (packRef 1). */
function pushFragment(objects: number): Uint8Array {
  return serializeLocator(Array.from({ length: objects }, (_, i) => ({ oidHex: oidOf(DASH_OBJECTS + i), packRef: 1, offset: 12 + i * 100, length: 90, deltaDepth: 0 })))
}

/**
 * A mock serving the dash shape: its two manifests (and a later push's), and the index's chunks;
 * counting what it serves of the big index.
 */
function dashSdk(packObjects = DASH_OBJECTS, later?: LaterPush): EvoSDK & { readonly served: { queries: number; chunks: number; bytes: number } } {
  const served = { queries: 0, chunks: 0, bytes: 0 }
  const manifest = (id: string, createdAt: number, kind: number, hash: string, sizeBytes: number, objectCount: number, chunkCount: number): Record<string, unknown> => ({
    $id: id,
    $createdAt: createdAt,
    $ownerId: 'owner',
    packHash: base58Encode(hexToBytes(hash)),
    kind,
    sizeBytes,
    chunkCount,
    objectCount,
    storage: 0,
    uris: [],
    tips: '',
    supersedes: '',
  })
  const manifests = [
    manifest('pack', 100, 0, 'a0'.repeat(32), 271_240_466, packObjects, 18_452),
    manifest('index', 110, 1, INDEX_HASH, INDEX.length, DASH_OBJECTS, INDEX_CHUNKS),
  ]
  const small = later?.fragment === true ? pushFragment(later.objects) : null
  const smallHash = small === null ? '' : bytesToHex(sha256(small))
  if (later !== undefined) manifests.push(manifest('push', 200, 0, 'a1'.repeat(32), 4_000, later.objects, 1))
  if (small !== null) manifests.push(manifest('push-index', 210, 1, smallHash, small.length, later?.objects ?? 0, 1))
  return {
    served,
    documents: {
      query: (q: { documentTypeName: string; where?: readonly (readonly unknown[])[] }): Promise<Map<string, unknown>> => {
        if (q.documentTypeName === DOC.packManifest) return Promise.resolve(new Map(manifests.map((d) => [String(d['$id']), d])))
        if (q.documentTypeName !== DOC.chunk) return Promise.resolve(new Map())
        const clause = (field: string): unknown => (q.where ?? []).find((w) => w[0] === field)?.[2]
        const hash = bytesToHex(base58Decode(String(clause('packHash'))))
        if (small !== null && hash === smallHash) return Promise.resolve(new Map([['c0', { seq: 0, d0: bytesToBase64(small) }]]))
        if (hash !== INDEX_HASH) return Promise.resolve(new Map())
        served.queries += 1
        const out = new Map<string, unknown>()
        for (const seq of clause('seq') as number[]) {
          const payload = INDEX.subarray(seq * CHUNK_PAYLOAD_MAX, (seq + 1) * CHUNK_PAYLOAD_MAX)
          served.chunks += 1
          served.bytes += payload.length
          out.set(`c${seq}`, { seq, d0: bytesToBase64(payload) })
        }
        return Promise.resolve(out)
      },
    },
  } as unknown as EvoSDK & { readonly served: { queries: number; chunks: number; bytes: number } }
}

/** The ready context's reader, or a failure naming the state. */
async function readerOf(sdk: EvoSDK): Promise<NonNullable<Awaited<ReturnType<typeof loadBrowseContext>> & { kind: 'ready' }>['context']['reader']> {
  const state = await loadBrowseContext(sdk, REPO)
  if (state.kind !== 'ready') throw new Error(`browse state ${state.kind}`)
  return state.context.reader
}

/** A page's lookups: one after the other, then a list's side by side. */
async function homeLookups(reader: { locate(oid: string): Promise<unknown> }): Promise<void> {
  for (let n = 0; n < HOME_SERIAL; n++) expect(await reader.locate(oidOf(n * 7919))).not.toBeNull()
  const column = Array.from({ length: LIST_LOOKUPS }, (_, i) => oidOf(100_000 + i * 4099))
  const found = await Promise.all(column.map((oid) => reader.locate(oid)))
  expect(found.every((e) => e !== null)).toBe(true)
}

describe('the browse index on a dash-sized repo (QW3-001)', () => {
  let store: ReturnType<typeof memoryArtifactStore>
  beforeEach(() => {
    clearChunkCache()
    resetBrowseCache()
    store = memoryArtifactStore()
    setIndexArtifactStore(store)
  })
  afterEach(() => setIndexArtifactStore(null))

  it(`resolves cold reading ${RESOLVE_CHUNKS} of its ${INDEX_CHUNKS} index chunks`, async () => {
    expect(INDEX.length).toBe(9_650_896)
    expect(INDEX_CHUNKS).toBe(657)
    const sdk = dashSdk()
    await readerOf(sdk)
    expect(sdk.served).toMatchObject({ queries: 1, chunks: RESOLVE_CHUNKS })
  })

  it('reads a cold page’s objects from a chunk of the index each: a sliver of it, in a few queries', async () => {
    const sdk = dashSdk()
    const reader = await readerOf(sdk)
    await homeLookups(reader)
    const { queries, chunks, bytes } = sdk.served
    // Was: 657 chunks (9.65 MB, about 12.6 MB with proofs) in 7 queries before the first row.
    expect(chunks).toBeLessThanOrEqual(RESOLVE_CHUNKS + HOME_LOOKUPS * LOOKUP_CHUNKS_MAX)
    expect(bytes).toBeLessThan(INDEX.length / 10)
    // The fanout, one per serial lookup, and the list's lookups gathered into one.
    expect(queries).toBeLessThanOrEqual(1 + HOME_SERIAL + 1)
  })

  it('reads nothing of the index on the next visit: the fanout and chunks read are kept in IndexedDB', async () => {
    await homeLookups(await readerOf(dashSdk()))
    // A new page load: the session's chunks and contexts are gone, IndexedDB is not.
    clearChunkCache()
    resetBrowseCache()
    const sdk = dashSdk()
    await homeLookups(await readerOf(sdk))
    expect(sdk.served).toMatchObject({ queries: 0, chunks: 0 })
  })

  it('reads the index whole, and checks it row by row, when its rows do not add up to the packs’ objects', async () => {
    // One object more in the pack than the index has rows: a pack it may not cover.
    const sdk = dashSdk(DASH_OBJECTS + 1)
    const state = await loadBrowseContext(sdk, REPO)
    expect(sdk.served.chunks).toBe(INDEX_CHUNKS + RESOLVE_CHUNKS - 1)
    // Row by row it covers the one pack: browsable, from the whole index (kept for next time).
    expect(state.kind).toBe('ready')
    expect([...store.entries.keys()].some((k) => k.endsWith(INDEX_HASH))).toBe(true)
  })

  it('reads a later push’s small fragment whole and still the big index a chunk at a time', async () => {
    const sdk = dashSdk(DASH_OBJECTS, { objects: 3, fragment: true })
    const reader = await readerOf(sdk)
    expect(sdk.served).toMatchObject({ queries: 1, chunks: RESOLVE_CHUNKS })
    // The pushed objects resolve from the small fragment, the imported ones from the big index.
    expect(await reader.locate(oidOf(DASH_OBJECTS + 2))).toMatchObject({ packRef: 1 })
    expect(await reader.locate(oidOf(42))).toMatchObject({ packRef: 0 })
    // Each lookup asks every fragment (the lowest packRef answers): two lookups of the big index.
    expect(sdk.served.chunks).toBeLessThanOrEqual(RESOLVE_CHUNKS + 2 * LOOKUP_CHUNKS_MAX)
  })

  it('says the index is behind a push whose own fragment never landed, without reading the index (D-920)', async () => {
    const sdk = dashSdk(DASH_OBJECTS, { objects: 3, fragment: false })
    expect(await loadBrowseContext(sdk, REPO)).toMatchObject({ kind: 'unindexed', reason: 'index-behind' })
    expect(sdk.served.chunks).toBe(RESOLVE_CHUNKS)
  })

  it('reads a walk’s index whole, in large queries, rather than a chunk at a time', async () => {
    const sdk = dashSdk()
    const reader = await readerOf(sdk)
    await reader.preloadIndex()
    expect(sdk.served.chunks).toBe(INDEX_CHUNKS)
    expect(sdk.served.queries).toBeLessThanOrEqual(1 + Math.ceil(INDEX_CHUNKS / 100))
    const before = sdk.served.chunks
    await homeLookups(reader)
    expect(sdk.served.chunks).toBe(before)
  })
})
