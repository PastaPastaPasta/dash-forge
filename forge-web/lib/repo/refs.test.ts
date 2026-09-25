/**
 * readRefs: the keyset scan over the `refState` index, against a mock Drive that serves
 * `refNameHash > x` pages exactly and reproduces the protocol-13 cursor bug for `startAfter`
 * (the cursor's `$id` bound leaks into every later `refNameHash` branch). The reader must
 * never send a cursor on that multi-branch query, must read a page-filling ref on its own,
 * and must fall back to the reflog read when a `prevOid` has no parent in what came back.
 * Parity: forge-core `refs::tests`.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import { base64ToHex, bytesToBase64 } from '../sdk'
import { DOC, type V1RepoRef } from './contract'
import { hasMissingParent, readRefs } from './refs'

const REPO: V1RepoRef = { kind: 'v1', contractId: 'contract', ownerId: 'owner', name: '' }

/** Real `sha256(refName)` — the rules layer rejects updates whose hash doesn't match. */
function refHashBytes(seed: number): Uint8Array {
  return sha256(new TextEncoder().encode(`refs/heads/ref-${seed}`))
}

function refHashHex(seed: number): string {
  return bytesToHex(refHashBytes(seed))
}

function oidHex(seed: number): string {
  return Array.from({ length: 20 }, () => seed.toString(16).padStart(2, '0')).join('')
}

type Doc = Record<string, unknown>

/** A refUpdate row; `$createdAt` is absent, as on the deployed repo-v1 type. */
function updateDoc(id: string, refSeed: number, newSeed: number, prevSeed = 0): Doc {
  return {
    $id: id,
    $ownerId: 'pusher',
    refNameHash: bytesToBase64(refHashBytes(refSeed)),
    refName: `refs/heads/ref-${refSeed}`,
    prevOid: prevSeed === 0 ? null : bytesToBase64(new Uint8Array(20).fill(prevSeed)),
    newOid: bytesToBase64(new Uint8Array(20).fill(newSeed)),
    force: false,
  }
}

/** A ref with `n` linear updates 1 → 2 → … → n. */
function chain(refSeed: number, n: number, nextId: () => string): Doc[] {
  return Array.from({ length: n }, (_, k) => updateDoc(nextId(), refSeed, k + 1, k))
}

interface QueryLike {
  documentTypeName: string
  where?: readonly (readonly [string, string, unknown])[]
  orderBy?: readonly (readonly [string, string])[]
  limit?: number
  startAfter?: string
}

const hexOf = (d: Doc): string => base64ToHex(d['refNameHash'] as string)

/**
 * In-memory Drive for `refUpdate` (protected is empty). Rows are kept in `refState` order
 * (`refNameHash`, then `$id` — `$createdAt` being absent). `dropOnKeyset` removes one `$id`
 * from keyset pages only, standing in for a node answering a correct query incompletely.
 */
function mockDrive(rows: Doc[], opts: { dropOnKeyset?: string; ignoreRange?: boolean } = {}) {
  const sorted = [...rows].sort((a, b) =>
    hexOf(a) < hexOf(b) ? -1 : hexOf(a) > hexOf(b) ? 1 : String(a['$id']) < String(b['$id']) ? -1 : 1,
  )
  const seen: QueryLike[] = []
  const page = (docs: Doc[], q: QueryLike): Doc[] => {
    let from = 0
    if (q.startAfter !== undefined) {
      const cursor = docs.find((d) => d['$id'] === q.startAfter) as Doc
      from = docs.indexOf(cursor) + 1
      // The protocol-13 lowering: the cursor's `$id` bound applies in sibling branches too.
      if (q.orderBy?.[0]?.[0] === 'refNameHash') {
        docs = docs.filter(
          (d, i) => i < from || hexOf(d) === hexOf(cursor) || String(d['$id']) > String(cursor['$id']),
        )
        from = docs.indexOf(cursor) + 1
      }
    }
    return docs.slice(from, from + (q.limit ?? 100))
  }
  const sdk = {
    documents: {
      query: (q: QueryLike): Promise<Map<string, unknown>> => {
        seen.push(q)
        let out: Doc[] = []
        if (q.documentTypeName === DOC.config) out = [{ $id: 'cfg', $createdAt: 1 }]
        else if (q.documentTypeName === DOC.refUpdate) {
          const where = q.where ?? []
          const gt = where.find((w) => w[1] === '>')
          const eq = where.find((w) => w[1] === '==')
          let docs = sorted
          if (gt && !opts.ignoreRange) docs = docs.filter((d) => hexOf(d) > base64ToHex(gt[2] as string))
          if (eq) docs = docs.filter((d) => hexOf(d) === base64ToHex(eq[2] as string))
          if (gt && opts.dropOnKeyset) docs = docs.filter((d) => d['$id'] !== opts.dropOnKeyset)
          if (!gt && !eq && q.orderBy?.[0]?.[0] === 'refNameHash' && opts.dropOnKeyset) {
            docs = docs.filter((d) => d['$id'] !== opts.dropOnKeyset)
          }
          if (q.orderBy?.[0]?.[0] === '$createdAt') {
            docs = [...docs].sort((a, b) => (String(a['$id']) < String(b['$id']) ? -1 : 1))
          }
          out = page(docs, q)
        }
        return Promise.resolve(new Map(out.map((d) => [String(d['$id']), d])))
      },
    },
  } as unknown as EvoSDK
  return { sdk, seen, sorted }
}

/** 60 refs × 1..4 updates, `$id`s running against hash order (the nightly repo's shape). */
function nightlyLike(): Doc[] {
  let n = 1000
  const nextId = (): string => `id${String(n--).padStart(6, '0')}`
  return Array.from({ length: 60 }, (_, r) => chain(r + 1, 1 + ((r + 1) % 4), nextId)).flat()
}

const isKeysetPage = (q: QueryLike): boolean =>
  q.documentTypeName === DOC.refUpdate && q.orderBy?.[0]?.[0] === 'refNameHash'

describe('the mock reproduces the protocol-13 cursor drop', () => {
  it('loses rows when refState is paged with startAfter', async () => {
    const { sdk, sorted } = mockDrive(nightlyLike())
    const got: Doc[] = []
    let startAfter: string | undefined
    for (;;) {
      const res = (await (sdk as unknown as { documents: { query: (q: QueryLike) => Promise<Map<string, Doc>> } }).documents.query({
        documentTypeName: DOC.refUpdate,
        orderBy: [
          ['refNameHash', 'asc'],
          ['$createdAt', 'asc'],
        ],
        limit: 100,
        startAfter,
      }))
      const page = [...res.values()]
      got.push(...page)
      if (page.length < 100) break
      startAfter = String(page[page.length - 1]?.['$id'])
    }
    expect(sorted.length).toBeGreaterThan(100)
    expect(got.length).toBeLessThan(sorted.length)
  })
})

describe('readRefs keyset scan', () => {
  it('reads every update with range pages and never a cursor on the multi-branch query', async () => {
    const { sdk, seen } = mockDrive(nightlyLike())
    const refs = await readRefs(sdk, REPO)

    expect(refs).toHaveLength(60)
    for (let r = 1; r <= 60; r++) {
      const ref = refs.find((x) => x.refNameHash === refHashHex(r))
      expect(ref?.state).toMatchObject({ state: 'resolved', oid: oidHex(1 + (r % 4)) })
    }
    const pages = seen.filter(isKeysetPage)
    expect(pages.every((q) => q.startAfter === undefined)).toBe(true)
    expect(pages.length).toBeLessThanOrEqual(3)
    // A consistent scan never falls back to the reflog read.
    expect(seen.some((q) => q.documentTypeName === DOC.refUpdate && q.orderBy?.[0]?.[0] === '$createdAt' && !q.where?.length)).toBe(false)
  })

  it('reads a page-filling ref on its own, then moves past it', async () => {
    let n = 0
    const nextId = (): string => `id${String(n++).padStart(6, '0')}`
    const rows = [...chain(5, 3, nextId), ...chain(7, 150, nextId), ...chain(9, 2, nextId)]
    const { sdk, seen } = mockDrive(rows)
    const refs = await readRefs(sdk, REPO)

    expect(refs.find((r) => r.refNameHash === refHashHex(7))?.state).toMatchObject({
      state: 'resolved',
      oid: oidHex(150),
    })
    expect(refs).toHaveLength(3)
    const eqReads = seen.filter((q) => q.where?.some((w) => w[1] === '==') && q.documentTypeName === DOC.refUpdate)
    expect(eqReads.map((q) => base64ToHex(q.where?.[0]?.[2] as string))).toContain(refHashHex(7))
  })

  it('falls back to the reflog read alone when a prevOid has no parent', async () => {
    const rows = nightlyLike()
    // Ref 2 has 3 updates; hide its middle one from keyset pages.
    const victim = rows.find(
      (d) => hexOf(d) === refHashHex(2) && base64ToHex(d['newOid'] as string) === oidHex(2),
    )?.['$id'] as string
    const { sdk, seen } = mockDrive(rows, { dropOnKeyset: victim })
    const refs = await readRefs(sdk, REPO)

    expect(seen.some((q) => q.documentTypeName === DOC.refUpdate && q.orderBy?.[0]?.[0] === '$createdAt' && !q.where?.length)).toBe(true)
    expect(refs.find((r) => r.refNameHash === refHashHex(2))?.state).toMatchObject({
      state: 'resolved',
      oid: oidHex(3),
    })
    expect(refs).toHaveLength(60)
  })

  it('abandons the scan on an out-of-range page and answers from the reflog read alone', async () => {
    // A node ignoring `refNameHash > last` serves the first page again: stop at once.
    const { sdk, seen } = mockDrive(nightlyLike(), { ignoreRange: true })
    const refs = await readRefs(sdk, REPO)
    expect(seen.filter(isKeysetPage).filter((q) => q.documentTypeName === DOC.refUpdate)).toHaveLength(2)
    expect(refs).toHaveLength(60)
    for (let r = 1; r <= 60; r++) {
      expect(refs.find((x) => x.refNameHash === refHashHex(r))?.state).toMatchObject({
        state: 'resolved',
        oid: oidHex(1 + (r % 4)),
      })
    }
  })
})

describe('hasMissingParent', () => {
  const u = (prevOid: string, newOid: string) => ({
    id: newOid,
    refNameHash: 'h',
    refName: 'refs/heads/x',
    prevOid,
    newOid,
    force: false,
    protected: false,
    author: 'a',
    createdAt: 0,
  })
  it('accepts a linked chain, a create and a delete', () => {
    expect(hasMissingParent([u('', 'aa'), u('aa', 'bb')])).toBe(false)
    expect(hasMissingParent([u('0000', 'aa'), u('aa', '0000')])).toBe(false)
  })
  it('flags a prevOid no update produced', () => {
    expect(hasMissingParent([u('', 'aa'), u('cc', 'dd')])).toBe(true)
  })
})
