/**
 * packManifest parsing.
 *
 * On-chain `tips` / `supersedes` are PACKED byteArrays (concatenated 20-/32-byte entries,
 * surfaced as base64), not lists; parsing them wrong makes `supersedes` silently empty, which
 * would let a superseded pack look current. `uris` is a native string array.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it } from 'vitest'

import { bytesToBase64 } from '../sdk'
import { readPackManifests } from './packs'
import type { RepoRef } from './contract'

const REPO: RepoRef = {
  forge: { core: 'CORE', collab: 'COLLAB', group: 'G' },
  repoId: 'R',
  ownerId: 'owner',
  name: 'n',
  visibility: 'public',
}

/** A 32-byte (or `len`-byte) hash filled with `seed`, as hex. */
function hashHex(seed: number, len = 32): string {
  return Array.from({ length: len }, () => seed.toString(16).padStart(2, '0')).join('')
}

function hashBytes(seed: number, len = 32): Uint8Array {
  return new Uint8Array(len).fill(seed)
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

  it('reads native uris and tolerates absent or malformed fields', async () => {
    const docs = await readPackManifests(
      mockSdk([
        { packHash: bytesToBase64(hashBytes(0xaa)), kind: 0, uris: ['https://m/p.pack'], supersedes: bytesToBase64(new Uint8Array(5)) },
        { packHash: bytesToBase64(hashBytes(0xbb)), kind: 0 },
      ]),
      REPO,
    )
    // The read's row order is the reader's concern (it pages ascending and reverses); look
    // the rows up by pack instead of by position.
    const byPack = (b: number) => docs.find((d) => d.packHash === hashHex(b))
    expect(byPack(0xaa)?.uris).toEqual(['https://m/p.pack'])
    expect(byPack(0xaa)?.supersedes).toEqual([])
    expect(byPack(0xbb)?.supersedes).toEqual([])
    expect(byPack(0xbb)?.tips).toEqual([])
    expect(byPack(0xbb)?.uris).toEqual([])
  })
})
