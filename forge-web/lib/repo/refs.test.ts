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
import { describe, expect, it, vi } from 'vitest'

import { base64ToHex, bytesToBase64, hexToBase64 } from '../sdk'
import { DOC, type RepoRef } from './contract'
import { hasMissingParent, keysetScan, keysetSplits, readRefs, splitHashRange } from './refs'

const REPO: RepoRef = {
  forge: { core: 'CORE', collab: 'COLLAB', group: 'G' },
  repoId: 'R',
  ownerId: 'owner',
  name: 'n',
  visibility: 'public',
}

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

/** A refUpdate row; `$createdAt` is left out, so rows order by `$id` alone. */
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
function mockDrive(rows: Doc[], opts: { dropOnKeyset?: string; ignoreRange?: boolean; latencyMs?: number } = {}) {
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
          // Drive checks a `>`/`<=` pair's bounds as base64 text (not byte order) and refuses
          // pairs that compare backwards: a reader must never send one.
          if (where.filter((w) => w[0] === 'refNameHash' && w[1] !== '==').length > 1) {
            return Promise.reject(new Error('query: multiple range clauses error: lower bounds must be under upper bounds'))
          }
          // Every query is scoped `repoId ==` (one repo here); the ref equality is the other `==`.
          const eq = where.find((w) => w[1] === '==' && w[0] === 'refNameHash')
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
        const result = new Map(out.map((d) => [String(d['$id']), d]))
        // `latencyMs`: every query takes that long, so a test can count serial round trips.
        return opts.latencyMs === undefined
          ? Promise.resolve(result)
          : new Promise((resolve) => setTimeout(() => resolve(result), opts.latencyMs))
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
    // The first page, then the rest as parallel ranges (one short page each here).
    expect(pages.length).toBeLessThanOrEqual(1 + 4)
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
    const refEq = (q: QueryLike) => q.where?.find((w) => w[0] === 'refNameHash' && w[1] === '==')
    const eqReads = seen.filter((q) => refEq(q) !== undefined && q.documentTypeName === DOC.refUpdate)
    expect(eqReads.map((q) => base64ToHex(refEq(q)?.[2] as string))).toContain(refHashHex(7))
  })

  it('falls back to the reflog read alone when a prevOid has no parent', async () => {
    const rows = nightlyLike()
    // Ref 2 has 3 updates; hide its middle one from keyset pages.
    const victim = rows.find(
      (d) => hexOf(d) === refHashHex(2) && base64ToHex(d['newOid'] as string) === oidHex(2),
    )?.['$id'] as string
    const { sdk, seen } = mockDrive(rows, { dropOnKeyset: victim })
    const refs = await readRefs(sdk, REPO)

    // The reflog read: `$createdAt` order, scoped to the repo and nothing else.
    const scopeOnly = (q: QueryLike) => (q.where ?? []).every((w) => w[0] === 'repoId')
    expect(seen.some((q) => q.documentTypeName === DOC.refUpdate && q.orderBy?.[0]?.[0] === '$createdAt' && scopeOnly(q))).toBe(true)
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
    // The first page reached past half the key space, so the rest is read on, not split: the
    // second page comes back out of range and the scan stops there.
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

describe('readRefs keyset scan on a large repo (L-15)', () => {
  /** `n` refs of one update each, `$id`s in hash order. */
  const manyRefs = (n: number): Doc[] => Array.from({ length: n }, (_, r) => updateDoc(`id${String(r).padStart(6, '0')}`, r + 1, 1))

  it('reads the rest of the key space in parallel ranges: a few serial rounds, not one per page', async () => {
    vi.useFakeTimers()
    try {
      const { sdk, seen } = mockDrive(manyRefs(700), { latencyMs: 100 })
      let done = false
      const reading = readRefs(sdk, REPO).then((refs) => {
        done = true
        return refs
      })
      let rounds = 0
      while (!done && rounds < 50) {
        await vi.advanceTimersByTimeAsync(100)
        rounds++
      }
      const refs = await reading
      expect(refs).toHaveLength(700)
      // Serially this is 8 keyset pages; split four ways it is the first page, then about two
      // pages per range (the config read runs alongside).
      expect(rounds).toBeLessThanOrEqual(4)
      // The ranges' queries overlap by up to a page (each reads past its ceiling), but each keeps
      // only the rows in its own range: 700 refs, none twice, and never a cursor.
      const keyset = seen.filter(isKeysetPage)
      expect(keyset.every((q) => q.startAfter === undefined)).toBe(true)
      expect(keyset.every((q) => (q.where ?? []).filter((w) => w[0] === 'refNameHash').length <= 1)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('abandons a split scan when a range comes back out of range', async () => {
    // 700 refs: the first page reaches about 1/7 of the key space, so the rest is split; a node
    // ignoring `refNameHash >` answers every range with the first page again.
    const { sdk, seen } = mockDrive(manyRefs(700), { ignoreRange: true })
    const refs = await readRefs(sdk, REPO)
    const keyset = seen.filter(isKeysetPage).filter((q) => q.documentTypeName === DOC.refUpdate)
    // The first page, then one page per range, each refused at once: no range reads on.
    expect(keyset).toHaveLength(1 + 4)
    // The scan is discarded and the answer comes from the reflog read alone, still whole.
    expect(refs).toHaveLength(700)
  })

  it('sizes the split from how far the first page reached', () => {
    // A first page reaching 1/8 of the key space: ~7 pages left, the cap of 4 ranges.
    expect(keysetSplits('2' + '0'.repeat(63))).toBe(4)
    // Reaching 40%: ~1.5 pages left, 2 ranges.
    expect(keysetSplits('66' + '0'.repeat(62))).toBe(2)
    // Reaching 60% or more: under a page left, no split.
    expect(keysetSplits('a' + '0'.repeat(63))).toBe(1)
  })

  it('covers the whole key space: every hash falls in exactly one range', () => {
    const after = '0'.repeat(64)
    const ceilings = splitHashRange(after, 4)
    const bounds = [after, ...ceilings, 'f'.repeat(64)]
    for (let r = 1; r <= 200; r++) {
      const h = refHashHex(r)
      const inRanges = bounds.slice(1).filter((ceil, i) => h > (bounds[i] as string) && h <= ceil)
      expect(inRanges).toHaveLength(1)
    }
  })

  it('keeps a ref exactly at the ceiling in its range and leaves the next one to the next range', async () => {
    let n = 0
    const nextId = (): string => `id${String(n++).padStart(6, '0')}`
    const rows = Array.from({ length: 30 }, (_, r) => chain(r + 1, 2, nextId)).flat()
    const { sdk } = mockDrive(rows)
    const hexes = [...new Set(rows.map(hexOf))].sort()
    const ceiling = hexes[12] as string
    const got = await keysetScan(sdk, REPO, DOC.refUpdate, { hex: hexes[3] as string, b64: hexToBase64(hexes[3] as string) }, ceiling)
    const refsGot = [...new Set((got ?? []).map(hexOf))].sort()
    expect(refsGot).toEqual(hexes.slice(4, 13))
    expect(got).toHaveLength(9 * 2)
  })

  it('reads a page-filling ref inside a bounded range on its own, and skips one above the ceiling', async () => {
    let n = 0
    const nextId = (): string => `id${String(n++).padStart(6, '0')}`
    const seeds = [1, 2, 3, 4, 5, 6]
    const byHex = new Map(seeds.map((s) => [refHashHex(s), s]))
    const sorted = [...byHex.keys()].sort()
    // In hash order: a, BIG (150 updates), b, | ceiling | BIG2 (150 updates), c, d.
    const [a, big, b, big2, c, d] = sorted.map((h) => byHex.get(h) as number) as [number, number, number, number, number, number]
    const rows = [...chain(a, 1, nextId), ...chain(big, 150, nextId), ...chain(b, 2, nextId), ...chain(big2, 150, nextId), ...chain(c, 1, nextId), ...chain(d, 1, nextId)]
    const { sdk, seen } = mockDrive(rows)
    const got = await keysetScan(sdk, REPO, DOC.refUpdate, { hex: '0'.repeat(64), b64: hexToBase64('0'.repeat(64)) }, sorted[2] as string)
    expect(got).toHaveLength(1 + 150 + 2)
    const eqReads = seen.filter((q) => q.where?.some((w) => w[0] === 'refNameHash' && w[1] === '=='))
    // BIG is read by equality (two pages of it); BIG2, above the ceiling, never is.
    const eqRefs = new Set(eqReads.map((q) => base64ToHex(q.where?.find((w) => w[1] === '==' && w[0] === 'refNameHash')?.[2] as string)))
    expect([...eqRefs]).toEqual([refHashHex(big)])
    expect(big2).not.toBe(big)
  })

  it('splits the key space above a bound into ranges that are increasing 32-byte keys', () => {
    const after = refHashHex(3)
    const ceilings = splitHashRange(after, 4)
    expect(ceilings).toHaveLength(3)
    const all = [after, ...ceilings]
    for (let i = 1; i < all.length; i++) {
      expect(all[i]).toHaveLength(64)
      expect((all[i] as string) > (all[i - 1] as string)).toBe(true)
    }
    expect(splitHashRange('f'.repeat(64), 4)).toEqual([])
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
