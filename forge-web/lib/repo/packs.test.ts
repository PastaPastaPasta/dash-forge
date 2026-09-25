/**
 * packManifest parsing + live-set correctness.
 *
 * On-chain `tips` / `supersedes` are PACKED byteArrays (concatenated 20-/32-byte entries,
 * surfaced as base64 — data-contracts §2.3), not JSON lists; parsing them wrong makes
 * `supersedes` silently empty, which would let superseded packs leak into the fallback
 * clone's live set. `liveGitPackManifests` mirrors forge-core `repo.rs::live_kind0_manifests`.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it } from 'vitest'

import { bytesToBase64 } from '../sdk'
import {
  liveGitPackManifests,
  liveLocatorManifests,
  readPackManifests,
  type PackManifest,
} from './packs'
import type { RepoRef } from './contract'

const REPO: RepoRef = { contractId: 'contract', ownerId: 'owner' }

/** A 32-byte (or `len`-byte) hash filled with `seed`, as hex. */
function hashHex(seed: number, len = 32): string {
  return Array.from({ length: len }, () => seed.toString(16).padStart(2, '0')).join('')
}

function hashBytes(seed: number, len = 32): Uint8Array {
  return new Uint8Array(len).fill(seed)
}

function manifest(overrides: Partial<PackManifest>): PackManifest {
  return {
    packHash: 'aa',
    kind: 0,
    sizeBytes: 0,
    objectCount: 0,
    chunkCount: 0,
    storage: 0,
    uris: [],
    tips: [],
    supersedes: [],
    createdAt: 0,
    documentId: 'd',
    ...overrides,
  }
}

/** A mock SDK whose packManifest query returns the given raw docs. */
function mockSdk(docs: Record<string, unknown>[]): EvoSDK {
  return {
    documents: {
      query: (): Promise<Map<string, unknown>> =>
        Promise.resolve(new Map(docs.map((d, i) => [`m${i}`, d]))),
    },
  } as unknown as EvoSDK
}

describe('packed byteArray parsing (tips / supersedes)', () => {
  it('parses packed 32-byte supersedes and 20-byte tips from base64', async () => {
    const supersedes = new Uint8Array(64)
    supersedes.set(hashBytes(0x11), 0)
    supersedes.set(hashBytes(0x22), 32)
    const tips = hashBytes(0x33, 20)

    const docs = await readPackManifests(
      mockSdk([
        {
          packHash: bytesToBase64(hashBytes(0xaa)),
          kind: 0,
          supersedes: bytesToBase64(supersedes),
          tips: bytesToBase64(tips),
        },
      ]),
      REPO,
    )

    expect(docs[0]?.supersedes).toEqual([hashHex(0x11), hashHex(0x22)])
    expect(docs[0]?.tips).toEqual([hashHex(0x33, 20)])
  })

  it('falls back to the legacy JSON-list shape and tolerates absent fields', async () => {
    const docs = await readPackManifests(
      mockSdk([
        { packHash: bytesToBase64(hashBytes(0xaa)), kind: 0, supersedes: '["deadbeef"]' },
        { packHash: bytesToBase64(hashBytes(0xbb)), kind: 0 },
      ]),
      REPO,
    )
    // The read's row order is the reader's concern (it pages ascending and reverses); look
    // the rows up by pack instead of by position.
    const byPack = (b: number) => docs.find((d) => d.packHash === hashHex(b))
    expect(byPack(0xaa)?.supersedes).toEqual(['deadbeef'])
    expect(byPack(0xbb)?.supersedes).toEqual([])
    expect(byPack(0xbb)?.tips).toEqual([])
  })
})

describe('liveGitPackManifests', () => {
  it('excludes superseded kind-0 packs and non-kind-0 manifests', () => {
    const old = manifest({ packHash: hashHex(0x01), documentId: 'a' })
    const repacked = manifest({
      packHash: hashHex(0x02),
      supersedes: [hashHex(0x01)],
      documentId: 'b',
    })
    const locator = manifest({ packHash: hashHex(0x03), kind: 1, documentId: 'c' })

    const live = liveGitPackManifests([locator, repacked, old])
    expect(live.map((m) => m.packHash)).toEqual([hashHex(0x02)])
  })

  it('honors supersedes carried on a non-kind-0 manifest', () => {
    const pack = manifest({ packHash: hashHex(0x01), documentId: 'a' })
    const locator = manifest({
      packHash: hashHex(0x03),
      kind: 1,
      supersedes: [hashHex(0x01)],
      documentId: 'c',
    })
    expect(liveGitPackManifests([pack, locator])).toEqual([])
  })

  it('is non-transitive and case-insensitive on hashes', () => {
    const a = manifest({ packHash: hashHex(0x01).toUpperCase(), documentId: 'a' })
    const b = manifest({ packHash: hashHex(0x02), supersedes: [hashHex(0x01)], documentId: 'b' })
    // b supersedes a; nothing supersedes b — b is live even though it references a chain.
    expect(liveGitPackManifests([a, b]).map((m) => m.documentId)).toEqual(['b'])
  })
})

describe('liveLocatorManifests', () => {
  it('returns live index fragments newest-first, dropping superseded ones', () => {
    // A repo between repacks has several live fragments — one per push — and the reader
    // merges them oldest-first, so the order this returns is load-bearing.
    const first = manifest({ packHash: hashHex(0x01), kind: 1, createdAt: 100, documentId: 'a' })
    const second = manifest({ packHash: hashHex(0x02), kind: 1, createdAt: 200, documentId: 'b' })
    const folded = manifest({
      packHash: hashHex(0x03),
      kind: 1,
      createdAt: 300,
      documentId: 'c',
      supersedes: [hashHex(0x01)],
    })
    const gitPack = manifest({ packHash: hashHex(0x04), createdAt: 400, documentId: 'd' })

    expect(liveLocatorManifests([gitPack, first, second, folded]).map((m) => m.documentId)).toEqual(
      ['c', 'b'],
    )
  })

  it('breaks $createdAt ties by documentId, descending', () => {
    const a = manifest({ packHash: hashHex(0x01), kind: 1, createdAt: 100, documentId: 'aa' })
    const b = manifest({ packHash: hashHex(0x02), kind: 1, createdAt: 100, documentId: 'bb' })
    expect(liveLocatorManifests([a, b]).map((m) => m.documentId)).toEqual(['bb', 'aa'])
  })
})
