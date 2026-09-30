/**
 * The session browse cache against a push it did not see (L-08, L-09, G4): a context resolved
 * before a push, a browser merge or a new index fragment must not keep answering "object not in
 * locator" for what landed since. The cache re-resolves once on such a miss, knows the pack
 * list's version, drops the context on this tab's own writes and on an explicit invalidate, and
 * does all that without spending a single extra read on the happy path.
 *
 * Built on real artifacts: single-blob git packs and index fragments over them, served as
 * `chunk` documents by a mock SDK whose manifest list a test can grow mid-run (the push).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { zlibSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { gitOidHex } from '../browse'
import { concat, objHeader, packFrame, T_BLOB } from '../browse/pack-fixtures'
import { indexPacks, serializeLocator } from '../browse/indexer'
import { CHUNK_PAYLOAD_MAX } from '../constants'
import { DOC, repoContentWritten, type RepoRef } from '../repo'
import { bytesToBase64 } from '../sdk'
import { base58Decode, base58Encode } from '../auth/base58'
import {
  browseGeneration,
  clearChunkCache,
  invalidateBrowseContext,
  loadBrowseContextCached,
  peekBrowseState,
  resetBrowseCache,
  subscribeBrowseGeneration,
} from './browse-source'
import { setIndexArtifactStore } from './index-cache'

const REPO: RepoRef = {
  forge: { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' },
  repoId: 'CACHEREPO',
  ownerId: 'owner',
  name: 'proj',
  visibility: 'public',
}

/** One push: a single-blob pack and the index fragment covering it at `packRef`. */
async function push(text: string, packRef: number, at: number) {
  const body = new TextEncoder().encode(text)
  const pack = packFrame(concat(objHeader(T_BLOB, body.length), zlibSync(body)))
  const oid = gitOidHex('blob', body)
  const fragment = serializeLocator((await indexPacks([pack])).map((row) => ({ ...row, packRef })))
  const hex = (b: Uint8Array) => bytesToHex(sha256(b))
  const doc = (id: string, kind: 0 | 1, bytes: Uint8Array, createdAt: number) => ({
    $id: id,
    $createdAt: createdAt,
    $ownerId: 'owner',
    // An identifier: base58, as the 4.2 SDK returns it.
    packHash: base58Encode(sha256(bytes)),
    kind,
    sizeBytes: bytes.length,
    chunkCount: 1,
    objectCount: kind === 0 ? 1 : 0,
    storage: 0,
    uris: [],
    tips: '',
    supersedes: '',
  })
  return {
    oid,
    text,
    docs: [doc(`p${packRef}`, 0, pack, at), doc(`f${packRef}`, 1, fragment, at + 1)],
    artifacts: [
      [hex(pack), pack],
      [hex(fragment), fragment],
    ] as [string, Uint8Array][],
  }
}

/** A mock SDK over a mutable manifest list; counts queries by document type. */
function repoSdk() {
  const manifests: Record<string, unknown>[] = []
  const artifacts = new Map<string, Uint8Array>()
  const queries: string[] = []
  /** Manifests a node a block behind has not seen (the newest ones). */
  let unseen = 0
  let chunksFail = false
  const sdk = {
    documents: {
      query: (q: { documentTypeName: string; where?: readonly (readonly unknown[])[]; limit?: number; startAfter?: string }) => {
        queries.push(q.documentTypeName)
        if (q.documentTypeName === 'maintainer') {
          return Promise.resolve(new Map([['m0', { $id: 'm0', $ownerId: 'owner', identityId: 'owner' }]]))
        }
        if (q.documentTypeName === DOC.packManifest) {
          let rows = [...manifests].sort((a, b) => (b['$createdAt'] as number) - (a['$createdAt'] as number)).slice(unseen)
          if (q.startAfter !== undefined) {
            const at = rows.findIndex((d) => d['$id'] === q.startAfter)
            rows = at < 0 ? [] : rows.slice(at + 1)
          }
          rows = rows.slice(0, Math.min(q.limit ?? 100, 100))
          return Promise.resolve(new Map(rows.map((d) => [String(d['$id']), d])))
        }
        if (q.documentTypeName === DOC.chunk) {
          if (chunksFail) return Promise.reject(new Error('node unavailable'))
          const packClause = (q.where ?? []).find((w) => w[0] === 'packHash')
          const seqClause = (q.where ?? []).find((w) => w[0] === 'seq')
          const bytes = artifacts.get(bytesToHex(base58Decode(String(packClause?.[2] ?? ''))))
          const out = new Map<string, unknown>()
          if (bytes === undefined) return Promise.resolve(out)
          for (const seq of (seqClause?.[2] as number[]) ?? [0]) {
            const from = seq * CHUNK_PAYLOAD_MAX
            if (from >= bytes.length) continue
            out.set(`c${seq}`, { seq, d0: bytesToBase64(bytes.subarray(from, Math.min(from + CHUNK_PAYLOAD_MAX, bytes.length))) })
          }
          return Promise.resolve(out)
        }
        return Promise.resolve(new Map())
      },
    },
  } as unknown as EvoSDK
  return {
    sdk,
    queries,
    /** Land a push: its pack and fragment manifests, and their bytes. */
    land(p: Awaited<ReturnType<typeof push>>) {
      manifests.push(...p.docs)
      for (const [h, b] of p.artifacts) artifacts.set(h, b)
    },
    manifestReads: () => queries.filter((t) => t === DOC.packManifest).length,
    reset: () => void (queries.length = 0),
    /** From now on, answer as a node that has not seen the newest `n` manifests. */
    behind: (n: number) => void (unseen = n),
    /** Fail every `chunk` query (an index fragment that will not load). */
    failChunks: (on: boolean) => void (chunksFail = on),
  }
}

async function readerOf(sdk: EvoSDK) {
  const state = await loadBrowseContextCached(sdk, REPO)
  if (state.kind !== 'ready') throw new Error(`expected ready, got ${state.kind}`)
  return state.context.reader
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

beforeEach(() => {
  resetBrowseCache()
  clearChunkCache()
  setIndexArtifactStore(null)
  vi.useRealTimers()
})
afterEach(() => vi.useRealTimers())

describe('browse cache: a push the cached context did not see (L-08)', () => {
  it('a read of an object pushed since re-resolves once and answers from the new context', async () => {
    const repo = repoSdk()
    const first = await push('first push\n', 0, 100)
    const second = await push('second push, e.g. a PR head\n', 1, 200)
    repo.land(first)
    const stale = await readerOf(repo.sdk)
    expect(text((await stale.readObject(first.oid)).bytes)).toBe(first.text)

    // Another client pushes; this tab's context still describes the first push only.
    repo.land(second)
    repo.reset()
    const obj = await stale.readObject(second.oid)
    expect(text(obj.bytes)).toBe(second.text)
    // One re-resolve: one manifest listing, nothing more.
    expect(repo.manifestReads()).toBe(1)
    // The cache now holds the newer context: the next view needs no resolve at all.
    const now = peekBrowseState(REPO.repoId)
    expect(now?.kind).toBe('ready')
    if (now?.kind === 'ready') expect(now.context.reader).not.toBe(stale)
  })

  it('an object that really is absent fails after exactly one re-resolve, and later misses reuse it', async () => {
    const repo = repoSdk()
    repo.land(await push('only push\n', 0, 100))
    const reader = await readerOf(repo.sdk)
    repo.reset()
    const absent = 'ab'.repeat(20)
    await expect(reader.readObject(absent)).rejects.toThrow(`object not in locator: ${absent}`)
    expect(repo.manifestReads()).toBe(1)
    // A walk meeting many absent objects (a fork's history) costs no further manifest reads.
    await expect(reader.readObject('cd'.repeat(20))).rejects.toThrow('object not in locator')
    await expect(reader.readObject('ef'.repeat(20))).rejects.toThrow('object not in locator')
    expect(repo.manifestReads()).toBe(1)
  })

  it('concurrent misses on one stale reader share one re-resolve', async () => {
    const repo = repoSdk()
    const first = await push('a\n', 0, 100)
    const second = await push('b\n', 1, 200)
    repo.land(first)
    const stale = await readerOf(repo.sdk)
    repo.land(second)
    repo.reset()
    const reads = await Promise.all([stale.readObject(second.oid), stale.readObject(second.oid), stale.readObject('00'.repeat(20)).catch(() => null)])
    expect(text(reads[0].bytes)).toBe('b\n')
    expect(repo.manifestReads()).toBe(1)
  })

  it('a failed re-resolve is not remembered: the next read asks again', async () => {
    const repo = repoSdk()
    const first = await push('a\n', 0, 100)
    const second = await push('b\n', 1, 200)
    repo.land(first)
    const stale = await readerOf(repo.sdk)
    repo.land(second)
    const query = repo.sdk.documents.query
    let fail = true
    vi.spyOn(repo.sdk.documents, 'query').mockImplementation(((q: { documentTypeName: string }) =>
      fail && q.documentTypeName === DOC.packManifest ? Promise.reject(new Error('node down')) : query(q as never)) as never)
    await expect(stale.readObject(second.oid)).rejects.toThrow('object not in locator')
    fail = false
    expect(text((await stale.readObject(second.oid)).bytes)).toBe('b\n')
  })
})

/** Wait until the background revalidation behind the cache has settled. */
async function settledRefresh(repo: { manifestReads: () => number }, reads: number): Promise<void> {
  await vi.waitFor(() => expect(repo.manifestReads()).toBe(reads))
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

describe('browse cache: versions and generations', () => {
  it("a revalidation that finds someone else's push replaces the context quietly: open views are not remounted", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const repo = repoSdk()
    repo.land(await push('a\n', 0, 100))
    const before = await readerOf(repo.sdk)
    const gen = browseGeneration(REPO.repoId)
    repo.land(await push('b\n', 1, 200))
    vi.setSystemTime(Date.now() + 31_000)
    repo.reset()
    // Stale-while-revalidate: the old state is served, the refresh runs behind it.
    expect(await readerOf(repo.sdk)).toBe(before)
    await settledRefresh(repo, 1)
    expect(browseGeneration(REPO.repoId)).toBe(gen)
    // The next view gets the newer context.
    expect(await readerOf(repo.sdk)).not.toBe(before)
  })

  it('a revalidation that finds the same pack list keeps the warm reader', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const repo = repoSdk()
    repo.land(await push('a\n', 0, 100))
    const before = await readerOf(repo.sdk)
    vi.setSystemTime(Date.now() + 31_000)
    repo.reset()
    await readerOf(repo.sdk)
    await settledRefresh(repo, 1)
    expect(await readerOf(repo.sdk)).toBe(before)
  })

  it('a lagging node that answers with an older pack list never rolls the cache back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const repo = repoSdk()
    repo.land(await push('a\n', 0, 100))
    const second = await push('b\n', 1, 200)
    repo.land(second)
    const current = await readerOf(repo.sdk)
    // Every node from now on is a block behind: it has not seen the second push.
    repo.behind(2)
    vi.setSystemTime(Date.now() + 31_000)
    repo.reset()
    await readerOf(repo.sdk)
    await settledRefresh(repo, 1)
    expect(await readerOf(repo.sdk)).toBe(current)
    expect(text((await current.readObject(second.oid)).bytes)).toBe('b\n')
  })

  it('an index fragment that failed to load once is picked up by the next revalidation (same pack list)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const repo = repoSdk()
    repo.land(await push('a\n', 0, 100))
    repo.failChunks(true)
    expect((await loadBrowseContextCached(repo.sdk, REPO)).kind).toBe('unindexed')
    repo.failChunks(false)
    vi.setSystemTime(Date.now() + 31_000)
    repo.reset()
    await loadBrowseContextCached(repo.sdk, REPO)
    await settledRefresh(repo, 1)
    expect((await loadBrowseContextCached(repo.sdk, REPO)).kind).toBe('ready')
  })

  it('a miss that finds a newer pack list announces it once, so the other views move too', async () => {
    const repo = repoSdk()
    repo.land(await push('a\n', 0, 100))
    const stale = await readerOf(repo.sdk)
    const second = await push('b\n', 1, 200)
    repo.land(second)
    const gen = browseGeneration(REPO.repoId)
    const seen: number[] = []
    const off = subscribeBrowseGeneration(() => seen.push(browseGeneration(REPO.repoId)))
    try {
      await stale.readObject(second.oid)
      await stale.readObject(second.oid)
      expect(seen).toEqual([gen + 1])
    } finally {
      off()
    }
  })

  it('invalidateBrowseContext ("Try again", a reload) drops the context and announces it', async () => {
    const repo = repoSdk()
    repo.land(await push('a\n', 0, 100))
    const before = await readerOf(repo.sdk)
    const gen = browseGeneration(REPO.repoId)
    invalidateBrowseContext(REPO.repoId)
    expect(browseGeneration(REPO.repoId)).toBe(gen + 1)
    expect(peekBrowseState(REPO.repoId)).toBeUndefined()
    repo.reset()
    const after = await readerOf(repo.sdk)
    expect(after).not.toBe(before)
    expect(repo.manifestReads()).toBe(1)
  })

  it("this tab's own write (a merge's pack or ref, a release) drops the context", async () => {
    const repo = repoSdk()
    repo.land(await push('a\n', 0, 100))
    await readerOf(repo.sdk)
    repoContentWritten(REPO)
    expect(peekBrowseState(REPO.repoId)).toBeUndefined()
    // Another repo's write leaves this one alone.
    await readerOf(repo.sdk)
    repoContentWritten({ ...REPO, repoId: 'OTHER' })
    expect(peekBrowseState(REPO.repoId)).toBeDefined()
  })})

describe('browse cache: request budget on the happy path', () => {
  it('a warm hit and a read the context holds cost no request at all', async () => {
    const repo = repoSdk()
    const first = await push('a\n', 0, 100)
    repo.land(first)
    const reader = await readerOf(repo.sdk)
    await reader.readObject(first.oid)
    repo.reset()
    // Navigating between the repo's pages, and reading what the index holds: nothing is asked.
    expect(await readerOf(repo.sdk)).toBe(reader)
    expect(await readerOf(repo.sdk)).toBe(reader)
    await reader.readObject(first.oid)
    expect(repo.queries).toEqual([])
  })

  it('a cold resolve reads the manifests once (plus the fragments), exactly as before', async () => {
    const repo = repoSdk()
    repo.land(await push('a\n', 0, 100))
    await readerOf(repo.sdk)
    expect(repo.manifestReads()).toBe(1)
    expect(repo.queries.filter((t) => t === DOC.chunk)).toHaveLength(1)
  })
})
