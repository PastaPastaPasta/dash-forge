/**
 * The pull index (L-44, L-77) against a Drive-shaped mock that answers composite queries the way
 * `documents.composite` does (see `issue-index.test.ts`). Every composite and plain read is
 * recorded, so each list page's request budget is asserted, not assumed: the rows batched per
 * 100-row composite, the base ref's history read once per base ref (not per PR), the repo feed
 * read once per repo (shared with the issue index), keyset pages past 100, and exact
 * Open / Merged / Closed counts.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'

import type { ForgeIds } from '../deployments'
import { bytesToBase64, hexToBase64, type DocumentQuery } from '../sdk'
import type { CompositeQuery } from '../sdk/composite'
import { invalidateRepoFeed, openCounts } from './issues'
import { queryIssues } from './issue-index'
import { foldPullOpenCount, queryPulls, type PullSelection } from './pull-index'
import type { RepoRef } from './contract'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', group: 'GROUP' }
const REPO = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const MAINT = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const COLLAB = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const AUTHOR = '7Ej2YTftCL23mVwvhviak8ZJMmpqcsVj7CU5KPxzyy4h'
const MAIN_HASH = bytesToBase64(sha256(new TextEncoder().encode('refs/heads/main')))

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
}

type Store = Record<string, Record<string, Doc[]>>

function mockSdk(store: Store, seen: Seen): EvoSDK {
  const rows = (c: string, t: string): Doc[] => store[c]?.[t] ?? []
  const query = async (q: DocumentQuery) => {
    seen.queries.push(q)
    const out = run(rows(q.dataContractId, q.documentTypeName), (q.where ?? []) as never, (q.orderBy ?? []) as never, q.limit ?? 100, q.startAfter)
    return new Map(out.map((d) => [String(d['$id']), d]))
  }
  const composite = async (q: CompositeQuery) => {
    seen.composites.push(q)
    const page = run(rows(q.dataContractId, q.documentType), (q.where ?? []) as never, (q.orderBy ?? []) as never, q.limit)
    const subResults = q.subQueries.map((s) => {
      const contract = s.dataContractId ?? q.dataContractId
      const values = s.bind === undefined ? null : [...new Set(page.map((d) => d[s.bind!.sourceProperty]).filter((v) => v !== undefined))]
      if (s.kind === 'counts') {
        const counts = new Map<string, bigint>()
        for (const v of values ?? []) {
          const n = rows(contract, s.documentType).filter((d) => d[s.bind!.field] === v).length
          if (n > 0) counts.set(String(v), BigInt(n))
        }
        return { kind: 'counts', counts }
      }
      const where = [...(s.where ?? []), ...(values === null ? [] : [[s.bind!.field, 'in', values] as const])]
      return { kind: 'documents', documents: run(rows(contract, s.documentType), where as never, (s.orderBy ?? []) as never, s.limit ?? 100) }
    })
    return { pageDocuments: page, subResults }
  }
  return { documents: { query, composite, count: async () => new Map() } } as unknown as EvoSDK
}

const oid = (n: number): string => n.toString(16).padStart(40, '0')
const pid = (n: number): string => `p${String(n).padStart(4, '0')}`

/**
 * `n` PRs into main, one per second, after main existed. Every 10th is merged at its head (a tip
 * main had); every 7th closed (the 21st, 42nd … by their author); #5 carries a merge whose oid
 * main never had (so it stays open); #3 and #203 labelled; 150 label events on #1 make the feed
 * longer than one page. Two issues share the feed.
 */
function bigRepo(n: number): Store {
  let t = 1_000_000
  const at = (): number => t++
  const merged = (i: number): boolean => i % 10 === 0
  const patches: Doc[] = []
  for (let i = 1; i <= n; i++) {
    patches.push({
      $id: pid(i),
      $ownerId: i % 4 === 0 ? AUTHOR : COLLAB,
      $createdAt: 2_000_000 + i * 1000,
      repoId: REPO,
      number: i,
      title: `PR ${i}${i === 42 ? ' fixes the parser' : ''}`,
      body: '',
      baseRefName: 'refs/heads/main',
      baseRefNameHash: MAIN_HASH,
      headOid: hexToBase64(oid(i)),
      sourceRepoId: REPO,
    })
  }
  // main: created before every PR, then moved to each merged PR's head.
  const refs: Doc[] = [{ $id: 'r0000', $ownerId: OWNER, $createdAt: 10, repoId: REPO, refName: 'refs/heads/main', refNameHash: MAIN_HASH, newOid: hexToBase64(oid(99_999)) }]
  for (let i = 10; i <= n; i += 10) refs.push({ $id: `r${String(i).padStart(4, '0')}`, $ownerId: OWNER, $createdAt: 20 + i, repoId: REPO, refName: 'refs/heads/main', refNameHash: MAIN_HASH, newOid: hexToBase64(oid(i)) })
  const ev = (target: string, number: number, kind: number, extra: Doc = {}): Doc => ({ $id: `e${at()}`, $ownerId: MAINT, $createdAt: t, repoId: REPO, targetId: target, targetNumber: number, kind, ...extra })
  const events: Doc[] = []
  const authorEvents: Doc[] = []
  for (let i = 1; i <= n; i++) {
    if (merged(i)) events.push(ev(pid(i), i, 3, { oid: hexToBase64(oid(i)) }))
    else if (i % 7 === 0) (i % 21 === 0 ? authorEvents : events).push({ ...ev(pid(i), i, 1), $ownerId: patches[i - 1]!['$ownerId'] })
  }
  events.push(ev(pid(5), 5, 3, { oid: hexToBase64(oid(123_456)) }))
  events.push(ev(pid(3), 3, 4, { value: 'bug' }), ev(pid(n), n, 4, { value: 'bug' }), ev(pid(9), 9, 6, { value: MAINT, refId: MAINT }))
  for (let k = 0; k < 150; k++) events.push(ev(pid(1), 1, k % 2 === 0 ? 4 : 5, { value: 'churn' }))
  events.push(ev('i0002', 2, 1))
  return {
    COLLAB: {
      patch: patches,
      issue: [1, 2].map((i) => ({ $id: `i000${i}`, $ownerId: AUTHOR, $createdAt: 1_500_000 + i, repoId: REPO, number: 1000 + i, title: `Issue ${i}`, body: '' })),
      event: events,
      authorEvent: authorEvents,
      comment: [pid(n), pid(n), pid(n - 1)].map((target, k) => ({ $id: `c${k}`, $ownerId: OWNER, $createdAt: 5 + k, repoId: REPO, targetId: target })),
    },
    CORE: {
      label: [{ $id: 'l1', $createdAt: 1, repoId: REPO, name: 'bug', color: '#d73a4a' }],
      config: [{ $id: 'cfg', $ownerId: OWNER, $createdAt: 5, repoId: REPO, defaultBranch: 'main', protectedPatterns: [] }],
      refUpdate: refs,
      protectedRefUpdate: [],
    },
  }
}

/** Expected counts of {@link bigRepo}(n): merged every 10th, closed every other 7th, #5's bad merge open. */
function expected(n: number): { merged: number; closed: number; open: number } {
  let merged = 0
  let closed = 0
  for (let i = 1; i <= n; i++) {
    if (i % 10 === 0) merged++
    else if (i % 7 === 0) closed++
  }
  return { merged, closed, open: n - merged - closed }
}

const base: PullSelection = { state: 'open', labels: [], author: null, assignee: null, sort: 'newest', text: '', page: 1, pageSize: 25 }

function fresh(n: number) {
  const seen: Seen = { composites: [], queries: [] }
  const repo = repoRef()
  invalidateRepoFeed(repo)
  return { sdk: mockSdk(bigRepo(n), seen), seen, repo }
}

const plainOf = (seen: Seen, type: string): DocumentQuery[] => seen.queries.filter((q) => q.documentTypeName === type)

describe('pull index', () => {
  it('lists the first page from one composite, with exact Open / Merged / Closed counts', async () => {
    const { sdk, seen, repo } = fresh(203)
    const page = await queryPulls(sdk, repo, base, 203, 'devnet')
    expect(page.rows).toHaveLength(25)
    expect(page.rows[0]?.number).toBe(202) // #203 (7 × 29) is closed
    expect(page.rows.every((r) => r.state.open)).toBe(true)
    expect(page.counts).toEqual(expected(203))
    expect(page.hasNext).toBe(true)
    // Budget: the first composite (rows + comment counts + names + labels + first feed pages),
    // `$id in` composites for the merged and closed PRs past the first 100 (one batch of ≤ 100),
    // the feed's continuation, and main's history ONCE — never a read per PR.
    expect(seen.composites.length).toBeLessThanOrEqual(2)
    expect(plainOf(seen, 'refUpdate')).toHaveLength(1)
    expect(plainOf(seen, 'protectedRefUpdate')).toHaveLength(1)
    expect(plainOf(seen, 'config').length).toBeLessThanOrEqual(1)
    expect(plainOf(seen, 'event').length).toBeGreaterThan(0) // the feed is longer than one page
    expect(seen.composites.length + seen.queries.length).toBeLessThanOrEqual(8)
    expect(page.rows.find((r) => r.number === 202)?.comments).toBe(1)
    expect(page.rows.find((r) => r.number === 201)?.comments).toBe(0)
  })

  it('pages past 100 with keyset composites, and knows the page count once every PR is read', async () => {
    const { sdk, seen, repo } = fresh(203)
    const p9 = await queryPulls(sdk, repo, { ...base, state: 'all', page: 9 }, 203, 'devnet')
    expect(p9.rows.map((r) => r.number)).toEqual([3, 2, 1])
    expect(p9.hasNext).toBe(false)
    expect(p9.matching).toBe(203)
    const keyset = seen.composites.filter((c) => (c.where ?? []).some(([f, op]) => f === '$createdAt' && op === '<='))
    expect(keyset.length).toBe(2) // 203 PRs = the first composite + two keyset chunks
  })

  it('shows the Merged and Closed tabs from the feed, past the loaded pages, without walking', async () => {
    const { sdk, seen, repo } = fresh(203)
    const merged = await queryPulls(sdk, repo, { ...base, state: 'merged', pageSize: 100 }, 203, 'devnet')
    expect(merged.rows.map((r) => r.number)).toEqual(Array.from({ length: 20 }, (_, k) => 200 - k * 10))
    const closed = await queryPulls(sdk, repo, { ...base, state: 'closed', pageSize: 100 }, 203, 'devnet')
    expect(closed.rows.map((r) => r.number)).toContain(21) // closed by its author (`authorEvent`)
    expect(closed.rows.every((r) => r.number % 7 === 0 && r.number % 10 !== 0)).toBe(true)
    expect(seen.composites.some((c) => (c.where ?? []).some(([f]) => f === '$createdAt'))).toBe(false)
  })

  it('keeps a PR whose merge names an oid the base never had open', async () => {
    const { sdk, repo } = fresh(30)
    const all = await queryPulls(sdk, repo, { ...base, state: 'all', pageSize: 100 }, 30, 'devnet')
    const five = all.rows.find((r) => r.number === 5)
    expect(five?.state.open).toBe(true)
    expect(five?.state.merged).toBe(false)
    expect(all.rows.find((r) => r.number === 10)?.state.merged).toBe(true)
    expect(all.counts).toEqual(expected(30))
  })

  it('filters by label, assignee, author and text, with counts under the filter', async () => {
    const { sdk, seen, repo } = fresh(203)
    const bug = await queryPulls(sdk, repo, { ...base, state: 'all', labels: ['bug'] }, 203, 'devnet')
    expect(bug.rows.map((r) => r.number)).toEqual([203, 3])
    expect(bug.counts).toEqual({ open: 1, merged: 0, closed: 1 })
    expect(bug.rows.find((r) => r.number === 203)?.state.labels).toEqual(['bug'])
    const assigned = await queryPulls(sdk, repo, { ...base, assignee: MAINT }, 203, 'devnet')
    expect(assigned.rows.map((r) => r.number)).toEqual([9])
    const text = await queryPulls(sdk, repo, { ...base, state: 'all', text: 'parser' }, 203, 'devnet')
    expect(text.rows.map((r) => r.number)).toEqual([42])
    const byNumber = await queryPulls(sdk, repo, { ...base, state: 'all', text: '#7' }, 203, 'devnet')
    expect(byNumber.rows.map((r) => r.number)).toEqual([7])
    const mine = await queryPulls(sdk, repo, { ...base, state: 'all', author: AUTHOR, pageSize: 100 }, 203, 'devnet')
    expect(mine.rows.every((r) => r.author === AUTHOR)).toBe(true)
    expect(mine.rows).toHaveLength(50)
    expect(seen.composites.some((c) => (c.where ?? []).some(([f]) => f === '$ownerId'))).toBe(true)
  })

  it('sorts oldest first by walking ascending, and by comment count', async () => {
    const { sdk, repo } = fresh(203)
    const oldest = await queryPulls(sdk, repo, { ...base, state: 'all', sort: 'oldest' }, 203, 'devnet')
    expect(oldest.rows.slice(0, 3).map((r) => r.number)).toEqual([1, 2, 3])
    const talked = await queryPulls(sdk, repo, { ...base, state: 'all', sort: 'comments' }, 203, 'devnet')
    expect(talked.rows.slice(0, 2).map((r) => [r.number, r.comments])).toEqual([[203, 2], [202, 1]])
  })

  it('reads the repo feed once for the issue index, the pull index and both header counts', async () => {
    const { sdk, seen, repo } = fresh(203)
    await Promise.all([
      queryIssues(sdk, repo, { state: 'open', labels: [], author: null, assignee: null, mentions: null, sort: 'newest', text: '', page: 1, pageSize: 50 }, 2, 'devnet'),
      queryPulls(sdk, repo, base, 203, 'devnet'),
    ])
    const eventPages = plainOf(seen, 'event').length
    expect(eventPages).toBeGreaterThan(0)
    // A second reader of either kind joins what is held: no feed page read again.
    await foldPullOpenCount(sdk, repo, 203, 'devnet')
    expect(plainOf(seen, 'event').length).toBe(eventPages)
    // One continuation of the 150+ row feed (a page past the composite's first 100), not two.
    expect(eventPages).toBeLessThanOrEqual(2)
  })

  it('gives the header the exact open PR count, reading nothing for a large repo until the tab has', async () => {
    const { sdk, seen, repo } = fresh(203)
    expect(await foldPullOpenCount(sdk, repo, 203, 'devnet')).toBeNull()
    expect(seen.composites.length + seen.queries.length).toBe(0)
    await queryPulls(sdk, repo, base, 203, 'devnet')
    const reads = seen.composites.length + seen.queries.length
    expect(await foldPullOpenCount(sdk, repo, 203, 'devnet')).toBe(expected(203).open)
    expect(seen.composites.length + seen.queries.length).toBe(reads)
    expect(openCounts(repo, { issues: null, pulls: 203 }).pulls).toBe(expected(203).open)
    // A newer PR (total 204) makes the proved count stale: no number rather than a wrong one.
    expect(openCounts(repo, { issues: null, pulls: 204 }).pulls).toBeNull()
  })

  it('reads a small repo whole in one composite, header included', async () => {
    const { sdk, seen, repo } = fresh(30)
    expect(await foldPullOpenCount(sdk, repo, 30, 'devnet')).toBe(expected(30).open)
    const page = await queryPulls(sdk, repo, base, 30, 'devnet')
    expect(page.counts).toEqual(expected(30))
    expect(seen.composites).toHaveLength(1)
    expect(plainOf(seen, 'refUpdate')).toHaveLength(1)
  })

  it('a write drops the index: the next page reads again', async () => {
    const { sdk, seen, repo } = fresh(30)
    await queryPulls(sdk, repo, base, 30, 'devnet')
    const reads = seen.composites.length
    await queryPulls(sdk, repo, { ...base, page: 1 }, 30, 'devnet')
    expect(seen.composites).toHaveLength(reads)
    invalidateRepoFeed(repo)
    await queryPulls(sdk, repo, base, 30, 'devnet')
    expect(seen.composites.length).toBeGreaterThan(reads)
  })
})
