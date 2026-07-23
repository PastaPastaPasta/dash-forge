/**
 * readRefs paths: the one-page fast path (small repos resolve from two parallel queries,
 * grouped locally) and the skip-scan fallback (a full page means the update set may be
 * incomplete, so enumeration must go back through `> last limit 1` hops + per-ref reads).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import { bytesToBase64 } from '../sdk'
import { DOC, type RepoRef } from './contract'
import { readRefs } from './refs'

const REPO: RepoRef = { contractId: 'contract', ownerId: 'owner' }

/** Real `sha256(refName)` — the rules layer rejects updates whose hash doesn't match. */
function refHashBytes(seed: number): Uint8Array {
  return sha256(new TextEncoder().encode(`refs/heads/ref-${seed}`))
}

function hashB64(seed: number): string {
  return bytesToBase64(refHashBytes(seed))
}

function refHashHex(seed: number): string {
  return bytesToHex(refHashBytes(seed))
}

function hashHex(seed: number): string {
  return Array.from({ length: 32 }, () => seed.toString(16).padStart(2, '0')).join('')
}

let nextId = 0
function updateDoc(
  hashSeed: number,
  oidSeed: number,
  createdAt: number,
  prevOidSeed: number | null = null,
): Record<string, unknown> {
  nextId += 1
  return {
    $id: `doc-${nextId}`,
    $ownerId: 'pusher',
    $createdAt: createdAt,
    refNameHash: hashB64(hashSeed),
    refName: `refs/heads/ref-${hashSeed}`,
    prevOid: prevOidSeed === null ? null : bytesToBase64(new Uint8Array(32).fill(prevOidSeed)),
    newOid: bytesToBase64(new Uint8Array(32).fill(oidSeed)),
    force: false,
  }
}

interface QueryLike {
  documentTypeName: string
  where?: readonly (readonly [string, string, unknown])[]
  orderBy?: readonly (readonly [string, string])[]
  limit?: number
}

/** Mock SDK whose `documents.query` is routed through `dispatch`; records every query. */
function mockSdk(
  dispatch: (q: QueryLike) => Record<string, unknown>[],
  seen: QueryLike[],
): EvoSDK {
  return {
    documents: {
      query: (q: QueryLike): Promise<Map<string, unknown>> => {
        seen.push(q)
        const docs = dispatch(q)
        return Promise.resolve(new Map(docs.map((d) => [String(d['$id']), d])))
      },
    },
  } as unknown as EvoSDK
}

const isFastPathPage = (q: QueryLike): boolean => q.orderBy?.length === 2 && q.limit === 100
const isSkipScanHop = (q: QueryLike): boolean => q.limit === 1 && q.orderBy?.length === 1

describe('readRefs fast path (whole update set in one page per type)', () => {
  it('resolves every ref from the two page queries with no skip-scan hops', async () => {
    const seen: QueryLike[] = []
    const sdk = mockSdk((q) => {
      if (q.documentTypeName === DOC.config) return [{ $id: 'cfg', $createdAt: 1 }]
      if (!isFastPathPage(q)) throw new Error(`unexpected query: ${JSON.stringify(q)}`)
      if (q.documentTypeName === DOC.refUpdate) {
        return [updateDoc(1, 0xaa, 10), updateDoc(1, 0xbb, 20, 0xaa), updateDoc(2, 0xcc, 15)]
      }
      return [] // protectedRefUpdate: none
    }, seen)

    const refs = await readRefs(sdk, REPO)

    const byName = new Map(refs.map((r) => [r.refName, r]))
    expect([...byName.keys()].sort()).toEqual(['refs/heads/ref-1', 'refs/heads/ref-2'])
    const ref1 = byName.get('refs/heads/ref-1')
    expect(ref1?.refNameHash).toBe(refHashHex(1))
    expect(ref1?.state).toMatchObject({ state: 'resolved', oid: hashHex(0xbb) })
    expect(byName.get('refs/heads/ref-2')?.state).toMatchObject({
      state: 'resolved',
      oid: hashHex(0xcc),
    })
    expect(seen.some(isSkipScanHop)).toBe(false)
  })

  it('merges protected updates into the same ref group', async () => {
    const sdk = mockSdk((q) => {
      if (q.documentTypeName === DOC.config) return [{ $id: 'cfg', $createdAt: 1 }]
      if (q.documentTypeName === DOC.refUpdate) return [updateDoc(1, 0xaa, 10)]
      return [updateDoc(1, 0xdd, 30, 0xaa)] // protectedRefUpdate, newer, supersedes 0xaa
    }, [])

    const refs = await readRefs(sdk, REPO)

    expect(refs).toHaveLength(1)
    expect(refs[0]?.state).toMatchObject({ state: 'resolved', oid: hashHex(0xdd) })
  })
})

describe('readRefs skip-scan fallback (a full page = possibly incomplete)', () => {
  it('falls back to enumeration + per-ref reads when the page overflows', async () => {
    // 100 refUpdate docs on one ref — the page is full, so the fast path must not trust it.
    const fullPage = Array.from({ length: 100 }, (_, i) => updateDoc(1, 0xaa, 10 + i))
    const seen: QueryLike[] = []
    const sdk = mockSdk((q) => {
      if (q.documentTypeName === DOC.config) return [{ $id: 'cfg', $createdAt: 1 }]
      if (isFastPathPage(q)) return q.documentTypeName === DOC.refUpdate ? fullPage : []
      if (isSkipScanHop(q)) {
        if (q.documentTypeName !== DOC.refUpdate) return []
        // hop 1: no where → first hash; hop 2: > hash(1) → done
        return q.where?.length ? [] : [fullPage[0] as Record<string, unknown>]
      }
      // per-ref history read (`refNameHash ==`, `$createdAt asc`)
      if (q.where?.[0]?.[1] === '==' && q.documentTypeName === DOC.refUpdate) {
        return [updateDoc(1, 0xee, 500)]
      }
      return []
    }, seen)

    const refs = await readRefs(sdk, REPO)

    expect(refs).toHaveLength(1)
    expect(refs[0]?.refNameHash).toBe(refHashHex(1))
    expect(refs[0]?.state).toMatchObject({ state: 'resolved', oid: hashHex(0xee) })
    expect(seen.some(isSkipScanHop)).toBe(true)
  })
})
