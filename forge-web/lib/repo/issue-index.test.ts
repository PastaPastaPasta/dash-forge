/**
 * The issue index (D-217, D-904, SR-03) against a Drive-shaped mock that answers composite
 * queries the way `documents.composite` does: the page (every `where` applied, ordered,
 * capped), counts per bound value, bound lookups and siblings. Every composite and plain read
 * is recorded, so the request budget of each list page is asserted, not assumed.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it } from 'vitest'

import type { ForgeIds } from '../deployments'
import type { DocumentQuery } from '../sdk'
import type { CompositeQuery } from '../sdk/composite'
import { invalidateRepoFeed } from './issues'
import { queryIssues, foldIssueOpenCount, type IssueSelection } from './issue-index'
import { openCounts } from './issues'
import type { RepoRef } from './contract'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', group: 'GROUP' }
const REPO = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const MAINT = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const COLLAB = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const AUTHOR = '7Ej2YTftCL23mVwvhviak8ZJMmpqcsVj7CU5KPxzyy4h'

type Doc = Record<string, unknown>

function repoRef(repoId = REPO): RepoRef {
  return { forge: FORGE, repoId, ownerId: OWNER, name: 'demo', visibility: 'public' }
}

function matches(doc: Doc, [field, op, value]: readonly [string, string, unknown]): boolean {
  const v = field.split('.').reduce<unknown>((o, k) => (o !== null && typeof o === 'object' ? (o as Doc)[k] : undefined), doc)
  switch (op) {
    case '==':
      return v === value
    case 'in':
      return Array.isArray(value) && value.includes(v)
    case '<=':
      return (v as number) <= (value as number)
    case '>=':
      return (v as number) >= (value as number)
    case '<':
      return (v as number) < (value as number)
    case '>':
      return (v as number) > (value as number)
    default:
      throw new Error(`mock: unsupported operator ${op}`)
  }
}

function run(rows: Doc[], where: readonly (readonly [string, string, unknown])[], orderBy: readonly (readonly [string, string])[], limit: number, startAfter?: string): Doc[] {
  let out = rows.filter((d) => where.every((w) => matches(d, w)))
  const dir = orderBy[orderBy.length - 1]?.[1]
  out.sort((a, b) => {
    for (const [f] of orderBy) {
      const av = a[f] as number | string
      const bv = b[f] as number | string
      if (av !== bv) return av < bv ? -1 : 1
    }
    return String(a['$id']) < String(b['$id']) ? -1 : 1
  })
  if (dir === 'desc') out.reverse()
  if (startAfter !== undefined) out = out.slice(out.findIndex((d) => d['$id'] === startAfter) + 1)
  return out.slice(0, Math.min(limit, 100))
}

interface Seen {
  composites: CompositeQuery[]
  queries: DocumentQuery[]
  counts: DocumentQuery[]
  /** Set to a promise to hold every composite's answer (computed when sent) until it resolves. */
  hold?: Promise<void> | null
}

/** A mock over `store[contract][type]` that also answers `documents.composite`. */
function mockSdk(store: Record<string, Record<string, Doc[]>>, seen: Seen): EvoSDK {
  const rows = (c: string, t: string): Doc[] => store[c]?.[t] ?? []
  const query = async (q: DocumentQuery) => {
    seen.queries.push(q)
    const out = run(rows(q.dataContractId, q.documentTypeName), (q.where ?? []) as never, (q.orderBy ?? []) as never, q.limit ?? 100, q.startAfter)
    return new Map(out.map((d) => [String(d['$id']), d]))
  }
  const composite = async (q: CompositeQuery & { subQueries: CompositeQuery['subQueries'] }) => {
    seen.composites.push(q)
    const held = seen.hold
    const page = run(rows(q.dataContractId, q.documentType), (q.where ?? []) as never, (q.orderBy ?? []) as never, q.limit)
    const subDocs: Doc[][] = []
    const subResults = q.subQueries.map((s, i) => {
      const contract = s.dataContractId ?? q.dataContractId
      const source = s.bind === undefined ? null : s.bind.source === undefined || s.bind.source === 'page' ? page : subDocs[s.bind.source as number] ?? []
      const values = source === null ? null : [...new Set(source.map((d) => d[s.bind!.sourceProperty]).filter((v) => v !== undefined))]
      const where = [...(s.where ?? []), ...(values === null ? [] : [[s.bind!.field, 'in', values] as const])]
      if (s.kind === 'counts') {
        const counts = new Map<string, bigint>()
        for (const v of values ?? []) {
          const n = rows(contract, s.documentType).filter((d) => d[s.bind!.field] === v).length
          if (n > 0) counts.set(String(v), BigInt(n))
        }
        subDocs[i] = []
        return { kind: 'counts', counts }
      }
      const docs = run(rows(contract, s.documentType), where as never, (s.orderBy ?? []) as never, s.limit ?? 100)
      subDocs[i] = docs
      return { kind: 'documents', documents: docs, missingIds: [] }
    })
    if (held) await held
    return { pageDocuments: page, subResults }
  }
  return {
    documents: {
      query,
      composite,
      count: async (q: DocumentQuery) => {
        seen.counts.push(q)
        return new Map([['', BigInt(run(rows(q.dataContractId, q.documentTypeName), (q.where ?? []) as never, [], 100).length)]])
      },
    },
  } as unknown as EvoSDK
}

/** `n` issues, one per second; events closing, labelling and assigning some of them. */
function bigRepo(n: number, repoId = REPO): Record<string, Record<string, Doc[]>> {
  const issues: Doc[] = []
  for (let i = 1; i <= n; i++) {
    issues.push({ $id: `i${String(i).padStart(4, '0')}`, $ownerId: i % 5 === 0 ? AUTHOR : OWNER, $createdAt: i * 1000, $updatedAt: i * 1000, repoId, number: i, title: `Issue ${i}`, body: i === 7 ? 'ping @alice' : '' })
  }
  let t = 1_000_000
  const ev = (target: number, kind: number, extra: Doc = {}): Doc => ({ $id: `e${t}`, $ownerId: MAINT, $createdAt: t++, repoId, targetId: `i${String(target).padStart(4, '0')}`, targetNumber: target, kind, ...extra })
  const events = [ev(3, 1), ev(33, 1), ev(103, 1), ev(10, 4, { value: 'tens' }), ev(110, 4, { value: 'tens' }), ev(7, 6, { value: COLLAB, refId: COLLAB }), ev(2, 4, { value: 'even' })]
  return {
    COLLAB: {
      issue: issues,
      event: events,
      authorEvent: [],
      comment: [{ $id: 'c1', $ownerId: OWNER, $createdAt: 5, repoId, targetId: 'i0050' }, { $id: 'c2', $ownerId: OWNER, $createdAt: 6, repoId, targetId: 'i0050' }, { $id: 'c3', $ownerId: OWNER, $createdAt: 7, repoId, targetId: 'i0100' }],
    },
    CORE: {
      label: [{ $id: 'l1', $createdAt: 1, repoId, name: 'tens', color: '#d73a4a' }],
    },
  }
}

const base: IssueSelection = { state: 'open', labels: [], author: null, assignee: null, mentions: null, sort: 'newest', text: '', page: 1, pageSize: 50 }

function fresh(n: number, repoId = REPO) {
  const seen: Seen = { composites: [], queries: [], counts: [] }
  const repo = repoRef(repoId)
  invalidateRepoFeed(repo)
  return { sdk: mockSdk(bigRepo(n, repoId), seen), seen, repo }
}

describe('issue index', () => {
  it('lists the first page in one composite with exact Open / Closed counts (SR-03)', async () => {
    const { sdk, seen, repo } = fresh(112)
    const page = await queryIssues(sdk, repo, base, 112, 'devnet')
    expect(page.rows.map((r) => r.number).slice(0, 3)).toEqual([112, 111, 110])
    expect(page.rows).toHaveLength(50)
    // Closed = #3, #33, #103 across both chunks; open = the rest: exact, not "of the newest 100".
    expect(page.closedCount).toBe(3)
    expect(page.openCount).toBe(109)
    expect(page.hasNext).toBe(true)
    // Budget: the first composite (issues + counts + names + feed + labels), plus one `$id in`
    // composite for #3 and #33 (closed, not in the first chunk). No per-row reads.
    expect(seen.composites).toHaveLength(2)
    expect(seen.queries).toHaveLength(0)
    expect(page.rows.find((r) => r.number === 110)?.state.labels).toEqual(['tens'])
    expect(page.rows.find((r) => r.number === 100)?.comments).toBe(1)
  })

  it('pages past 100 with a keyset composite (D-904)', async () => {
    const { sdk, seen, repo } = fresh(112)
    const p3 = await queryIssues(sdk, repo, { ...base, state: 'all', page: 3 }, 112, 'devnet')
    expect(p3.rows.map((r) => r.number)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
    expect(p3.hasNext).toBe(false)
    const keyset = seen.composites.find((c) => (c.where ?? []).some(([f, op]) => f === '$createdAt' && op === '<='))
    expect(keyset).toBeDefined()
    expect(p3.matching).toBe(112)
  })

  it('sorts oldest first by walking ascending', async () => {
    const { sdk, repo } = fresh(112)
    const page = await queryIssues(sdk, repo, { ...base, state: 'all', sort: 'oldest' }, 112, 'devnet')
    expect(page.rows.slice(0, 3).map((r) => r.number)).toEqual([1, 2, 3])
  })

  it('finds closed and labelled issues past the first chunk from the feed, not by walking', async () => {
    const { sdk, seen, repo } = fresh(112)
    const closed = await queryIssues(sdk, repo, { ...base, state: 'closed' }, 112, 'devnet')
    expect(closed.rows.map((r) => r.number)).toEqual([103, 33, 3])
    const tens = await queryIssues(sdk, repo, { ...base, state: 'all', labels: ['tens'] }, 112, 'devnet')
    expect(tens.rows.map((r) => r.number)).toEqual([110, 10])
    expect(tens.openCount).toBe(2)
    expect(tens.closedCount).toBe(0)
    // No keyset walk was needed for either.
    expect(seen.composites.some((c) => (c.where ?? []).some(([f]) => f === '$createdAt'))).toBe(false)
  })

  it('answers "assigned to" and "no assignee" from the fold', async () => {
    const { sdk, repo } = fresh(112)
    const mine = await queryIssues(sdk, repo, { ...base, assignee: COLLAB }, 112, 'devnet')
    expect(mine.rows.map((r) => r.number)).toEqual([7])
    expect(mine.rows[0]?.state.assignees).toEqual([COLLAB])
    const nobody = await queryIssues(sdk, repo, { ...base, state: 'all', assignee: 'none', pageSize: 200 }, 112, 'devnet')
    expect(nobody.rows.some((r) => r.number === 7)).toBe(false)
  })

  it('filters by author through the author index', async () => {
    const { sdk, seen, repo } = fresh(112)
    const page = await queryIssues(sdk, repo, { ...base, state: 'all', author: AUTHOR, pageSize: 100 }, 112, 'devnet')
    expect(page.rows.map((r) => r.number)).toEqual([110, 105, 100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5])
    expect(seen.composites.some((c) => (c.where ?? []).some(([f]) => f === '$ownerId'))).toBe(true)
    expect(page.openCount).toBe(22)
  })

  it('searches titles and mentions, saying how much it searched', async () => {
    const { sdk, repo } = fresh(112)
    const hit = await queryIssues(sdk, repo, { ...base, text: 'issue 11' }, 112, 'devnet')
    expect(hit.rows.map((r) => r.number)).toEqual([112, 111, 110, 11])
    expect(hit.searchedOf).toBeNull() // the walk reached the end: complete
    const mention = await queryIssues(sdk, repo, { ...base, mentions: { id: 'X', name: 'alice.dash' } }, 112, 'devnet')
    expect(mention.rows.map((r) => r.number)).toEqual([7])
  })

  it('sorts by comment count', async () => {
    const { sdk, repo } = fresh(112)
    const page = await queryIssues(sdk, repo, { ...base, sort: 'comments' }, 112, 'devnet')
    expect(page.rows.slice(0, 2).map((r) => [r.number, r.comments])).toEqual([[50, 2], [100, 1]])
  })

  it('gives the header the exact open count without a second fold', async () => {
    const { sdk, seen, repo } = fresh(112)
    // A cold header on a repo past one chunk reads nothing (the Issues tab reads it).
    expect(await foldIssueOpenCount(sdk, repo, 112, 'devnet')).toBeNull()
    expect(seen.composites).toHaveLength(0)
    await queryIssues(sdk, repo, base, 112, 'devnet')
    const reads = seen.composites.length
    expect(await foldIssueOpenCount(sdk, repo, 112, 'devnet')).toBe(109)
    expect(seen.composites).toHaveLength(reads)
    expect(openCounts(repo, { issues: 112, pulls: 0 }).issues).toBe(109)
    // A newer issue (total 113) makes the proved count stale: no number rather than a wrong one.
    expect(openCounts(repo, { issues: 113, pulls: 0 }).issues).toBeNull()
  })

  it('sorts a small repo oldest first from the one composite (no second walk)', async () => {
    const { sdk, seen, repo } = fresh(12, 'Ad88NKGHimxUgGHrTGpBJjKpnzrQe8Zh4V5q13mRh85h')
    const page = await queryIssues(sdk, repo, { ...base, state: 'all', sort: 'oldest' }, 12, 'devnet')
    expect(page.rows.map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(page.matching).toBe(12)
    expect(seen.composites).toHaveLength(1)
  })

  it('keeps a walk correct when two list pages load at once', async () => {
    const { sdk, repo } = fresh(250)
    const q = { ...base, state: 'all' as const }
    const [a, b] = await Promise.all([queryIssues(sdk, repo, { ...q, page: 3 }, 250, 'devnet'), queryIssues(sdk, repo, { ...q, page: 4 }, 250, 'devnet')])
    expect(a.rows.map((r) => r.number)[0]).toBe(150)
    expect(b.rows.map((r) => r.number)[0]).toBe(100)
    expect(b.hasNext).toBe(true)
    const last = await queryIssues(sdk, repo, { ...q, page: 5 }, 250, 'devnet')
    expect(last.rows.map((r) => r.number)).toEqual(Array.from({ length: 50 }, (_, i) => 50 - i))
    expect(last.matching).toBe(250)
    // No row listed twice.
    expect(new Set(last.rows.map((r) => r.id)).size).toBe(50)
  })

  it('a read in flight across a write neither refills the shared feed nor settles a count (L-77 review)', async () => {
    const repoId = 'Ad88NKGHimxUgGHrTGpBJjKpnzrQe8Zh4V5q13mRh85h'
    const store = bigRepo(12, repoId)
    const seen: Seen = { composites: [], queries: [], counts: [] }
    const sdk = mockSdk(store, seen)
    const repo = repoRef(repoId)
    invalidateRepoFeed(repo)
    // The header's index load sends its composite (the whole feed rides in it) and is held...
    let release!: () => void
    seen.hold = new Promise((r) => (release = r))
    const stale = foldIssueOpenCount(sdk, repo, 12, 'devnet')
    await Promise.resolve()
    // ...a maintainer closes #5, and the write drops the repo's caches...
    store.COLLAB!.event!.push({ $id: 'eclose', $ownerId: MAINT, $createdAt: 9_000_000, repoId, targetId: 'i0005', targetNumber: 5, kind: 1 })
    invalidateRepoFeed(repo)
    seen.hold = null
    release()
    await stale
    // ...so the header shows no count from before the write, and the next read shows #5 closed.
    expect(openCounts(repo, { issues: 12, pulls: 0 }).issues).toBeNull()
    const page = await queryIssues(sdk, repo, { ...base, state: 'closed' }, 12, 'devnet')
    expect(page.rows.map((r) => r.number)).toEqual([5, 3])
    expect(page.openCount).toBe(10)
  })

  it('reads a small repo whole in one composite, header included', async () => {
    const { sdk, seen, repo } = fresh(12, 'Ad88NKGHimxUgGHrTGpBJjKpnzrQe8Zh4V5q13mRh85h')
    // Only #3 of the fixture's closed issues exists in a 12-issue repo; the feed's other
    // targets (#33, #103) are known not to be issues once every issue is loaded, unread.
    expect(await foldIssueOpenCount(sdk, repo, 12, 'devnet')).toBe(11)
    const page = await queryIssues(sdk, repo, base, 12, 'devnet')
    expect(page.openCount).toBe(11)
    expect(page.closedCount).toBe(1)
    expect(seen.composites).toHaveLength(1)
  })
})
