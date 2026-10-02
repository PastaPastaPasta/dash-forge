/**
 * The issue index (D-217, D-904, SR-03) against a Drive-shaped mock that answers composite
 * queries the way `documents.composite` does: the page (every `where` applied, ordered,
 * capped), counts per bound value, bound lookups and siblings. Every composite and plain read
 * is recorded, so the request budget of each list page is asserted, not assumed.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { ForgeIds } from '../deployments'
import { mockSdk, newSeen, type Doc, type Seen } from './drive-mock'
import { invalidateRepoFeed, sharedRepoCounts } from './issues'
import { queryIssues, type IssueSelection } from './issue-index'
import type { RepoRef } from './contract'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const REPO = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const MAINT = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const COLLAB = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const AUTHOR = '7Ej2YTftCL23mVwvhviak8ZJMmpqcsVj7CU5KPxzyy4h'


/** Issue `n`'s document id: a real 32-byte identifier (state sums key targets by their bytes). */
const IID = (n: number): string => base58Encode(sha256(new TextEncoder().encode(`i${String(n).padStart(4, '0')}`)))

function repoRef(repoId = REPO): RepoRef {
  return { forge: FORGE, repoId, ownerId: OWNER, name: 'demo', visibility: 'public' }
}

/** `n` issues, one per second; transitions closing some, events labelling and assigning some. */
function bigRepo(n: number, repoId = REPO): Record<string, Record<string, Doc[]>> {
  const issues: Doc[] = []
  for (let i = 1; i <= n; i++) {
    issues.push({ $id: IID(i), $ownerId: i % 5 === 0 ? AUTHOR : OWNER, $createdAt: i * 1000, $updatedAt: i * 1000, repoId, number: i, title: `Issue ${i}`, body: i === 7 ? 'ping @alice' : '' })
  }
  let t = 1_000_000
  const ev = (target: number, kind: number, extra: Doc = {}): Doc => ({ $id: `e${t}`, $ownerId: MAINT, $createdAt: t++, repoId, targetId: IID(target), targetNumber: target, kind, ...extra })
  const close = (target: number, kind = 1, delta = 1): Doc => ({ $id: `t${t}`, $ownerId: MAINT, $createdAt: t++, repoId, targetId: IID(target), targetNumber: target, targetKind: 0, kind, delta, asAuthor: 0 })
  const events = [ev(10, 4, { value: 'tens' }), ev(110, 4, { value: 'tens' }), ev(7, 6, { value: COLLAB, refId: COLLAB }), ev(2, 4, { value: 'even' })]
  // #3, #33 and #103 end closed; #40 was closed and reopened (a closed-tab candidate, now open).
  // In a small repo the closes of issues it does not have are left out (every transition names
  // one of the repo's own issues).
  const transitions = [close(3), close(33), close(103), close(40), close(40, 2, -1)].filter((d) => (d['targetNumber'] as number) <= n)
  return {
    COLLAB: {
      issue: issues,
      event: events,
      transition: transitions,
      comment: [{ $id: 'c1', $ownerId: OWNER, $createdAt: 5, repoId, targetId: IID(50) }, { $id: 'c2', $ownerId: OWNER, $createdAt: 6, repoId, targetId: IID(50) }, { $id: 'c3', $ownerId: OWNER, $createdAt: 7, repoId, targetId: IID(100) }],
    },
    CORE: {
      label: [{ $id: 'l1', $createdAt: 1, repoId, name: 'tens', color: '#d73a4a' }],
    },
  }
}

const base: IssueSelection = { state: 'open', labels: [], author: null, assignee: null, mentions: null, sort: 'newest', text: '', page: 1, pageSize: 50 }

function fresh(n: number, repoId = REPO) {
  const seen: Seen = newSeen()
  const repo = repoRef(repoId)
  invalidateRepoFeed(repo)
  const store = bigRepo(n, repoId)
  return { sdk: mockSdk(store, seen), seen, repo, store }
}

describe('issue index', () => {
  it('lists the first page in one composite with exact Open / Closed counts (SR-03)', async () => {
    const { sdk, seen, repo } = fresh(112)
    const page = await queryIssues(sdk, repo, base, 112, 'devnet')
    expect(page.rows.map((r) => r.number).slice(0, 3)).toEqual([112, 111, 110])
    expect(page.rows).toHaveLength(50)
    // Closed = #3, #33, #103 (#40 was reopened); open = the rest: proved totals, not a fold.
    expect(page.closedCount).toBe(3)
    expect(page.openCount).toBe(109)
    expect(page.hasNext).toBe(true)
    // Budget: the first composite (issues + counts + names + feed + labels), one sum query for
    // its rows' state, and the three proved counts. No per-row reads, no closed-target reads.
    expect(seen.composites).toHaveLength(1)
    expect(seen.queries).toHaveLength(0)
    expect(seen.sums).toHaveLength(1)
    expect(seen.sums[0]?.where?.[0]?.[1]).toBe('in')
    expect(seen.counts.map((q) => q.documentTypeName).sort()).toEqual(['issue', 'patch', 'transition'])
    expect(page.rows.find((r) => r.number === 110)?.state.labels).toEqual(['tens'])
    expect(page.rows.find((r) => r.number === 100)?.comments).toBe(1)
  })

  it('shares one counts read between the index, the header tabs and the list total, until a write', async () => {
    const { sdk, seen, repo } = fresh(112)
    // The Issues list asks three times on one load: the header's open-count tabs, the list's
    // total, and the index's Open / Closed counts. One set of the three proved counts answers all.
    const [page, tabs, total] = await Promise.all([queryIssues(sdk, repo, base, 112, 'devnet'), sharedRepoCounts(sdk, repo), sharedRepoCounts(sdk, repo)])
    expect(await sharedRepoCounts(sdk, repo)).toBe(tabs)
    expect(total).toBe(tabs)
    expect(page.openCount).toBe(tabs.issuesOpen)
    expect(seen.counts.map((q) => q.documentTypeName).sort()).toEqual(['issue', 'patch', 'transition'])
    // A write that can change a count is a new generation: the next reader counts again.
    invalidateRepoFeed(repo)
    await sharedRepoCounts(sdk, repo)
    expect(seen.counts).toHaveLength(6)
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

  it('finds a sparse Closed tab from the close transitions and labelled issues from the feed, not by walking', async () => {
    // 3 closed among 1,000: walking to them would take ten chunks, their transitions one page.
    const { sdk, seen, repo } = fresh(1000)
    const closed = await queryIssues(sdk, repo, { ...base, state: 'closed' }, 1000, 'devnet')
    // #40 was closed and reopened: a candidate, filtered out by its state.
    expect(closed.rows.map((r) => r.number)).toEqual([103, 33, 3])
    expect(closed.matching).toBe(3)
    const closeReads = seen.queries.filter((q) => q.documentTypeName === 'transition')
    expect(closeReads.map((q) => q.where)).toEqual([[['repoId', '==', REPO], ['kind', '==', 1]]])
    const tens = await queryIssues(sdk, repo, { ...base, state: 'all', labels: ['tens'] }, 1000, 'devnet')
    expect(tens.rows.map((r) => r.number)).toEqual([110, 10])
    expect(tens.openCount).toBe(2)
    expect(tens.closedCount).toBe(0)
    // No keyset walk was needed for either.
    expect(seen.composites.some((c) => (c.where ?? []).some(([f]) => f === '$createdAt'))).toBe(false)
  })

  it('filters by close reason from the one read of the close transitions (QW4-028)', async () => {
    const { sdk, seen, repo, store } = fresh(1000)
    // #33 closed as not planned, #103 as a duplicate of #3, #3 with no reason (completed); #40 was
    // closed as not planned and reopened, so it is not a not-planned issue now.
    const closes = store['COLLAB']!['transition']!
    const reason = (n: number, r: number, extra: Doc = {}): void => {
      const t = closes.find((d) => d['targetNumber'] === n && d['kind'] === 1)!
      Object.assign(t, { reason: r, ...extra })
    }
    reason(33, 2)
    reason(103, 3, { dupNumber: 3 })
    reason(40, 2)
    const notPlanned = await queryIssues(sdk, repo, { ...base, state: 'all', reason: 'not_planned' }, 1000, 'devnet')
    expect(notPlanned.rows.map((r) => r.number)).toEqual([33])
    expect(notPlanned.openCount).toBe(0)
    expect(notPlanned.closedCount).toBe(1)
    expect((await queryIssues(sdk, repo, { ...base, state: 'closed', reason: 'duplicate' }, 1000, 'devnet')).rows.map((r) => r.number)).toEqual([103])
    // A close that gives no reason is a completed one.
    expect((await queryIssues(sdk, repo, { ...base, state: 'closed', reason: 'completed' }, 1000, 'devnet')).rows.map((r) => r.number)).toEqual([3])
    // On an open tab nothing matches (a reason is a closed issue's), and nothing is resolved for it.
    const before = seen.composites.length + seen.queries.length
    expect((await queryIssues(sdk, repo, { ...base, state: 'open', reason: 'not_planned' }, 1000, 'devnet')).rows).toEqual([])
    expect(seen.composites.length + seen.queries.length).toBe(before)
    // Budget: the close transitions are read once for every reason and tab, and nothing is walked.
    const closeReads = seen.queries.filter((q) => q.documentTypeName === 'transition')
    expect(closeReads.map((q) => q.where)).toEqual([[['repoId', '==', REPO], ['kind', '==', 1]]])
    expect(seen.composites.some((c) => (c.where ?? []).some(([f]) => f === '$createdAt'))).toBe(false)
  })

  it('walks a Closed tab when that is cheaper than its transitions, and stops once the proved count is reached', async () => {
    // 3 closed among 112: the second chunk holds them all, and the count says there are no more.
    const { sdk, seen, repo } = fresh(112)
    const closed = await queryIssues(sdk, repo, { ...base, state: 'closed' }, 112, 'devnet')
    expect(closed.rows.map((r) => r.number)).toEqual([103, 33, 3])
    expect(closed.matching).toBe(3)
    expect(closed.searchedOf).toBeNull()
    expect(seen.queries.filter((q) => q.documentTypeName === 'transition')).toHaveLength(0)
    expect(seen.composites).toHaveLength(2)
    expect(seen.sums).toHaveLength(2)
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

  it('counts under a filter from the rows it resolved, and the whole repo from the proved totals', async () => {
    const { sdk, repo } = fresh(112)
    const all = await queryIssues(sdk, repo, { ...base, state: 'all' }, 112, 'devnet')
    expect([all.openCount, all.closedCount]).toEqual([109, 3])
    const tens = await queryIssues(sdk, repo, { ...base, labels: ['tens'] }, 112, 'devnet')
    expect([tens.openCount, tens.closedCount]).toEqual([2, 0])
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

  it('a read in flight across a write does not refill the shared feed (L-77 review)', async () => {
    const { sdk, seen, repo, store } = fresh(12, 'Ad88NKGHimxUgGHrTGpBJjKpnzrQe8Zh4V5q13mRh85h')
    let release!: () => void
    seen.hold = new Promise((r) => (release = r))
    const stale = queryIssues(sdk, repo, base, 12, 'devnet')
    await Promise.resolve()
    // A maintainer labels #5 while the composite (whose feed page is from before) is held.
    store.COLLAB!.event!.push({ $id: 'elabel', $ownerId: MAINT, $createdAt: 9_000_000, repoId: repo.repoId, targetId: IID(5), targetNumber: 5, kind: 4, value: 'late' })
    invalidateRepoFeed(repo)
    seen.hold = null
    release()
    await stale
    const after = await queryIssues(sdk, repo, { ...base, labels: ['late'] }, 12, 'devnet')
    expect(after.rows.map((r) => r.number)).toEqual([5])
  })

  it('a state read that fails on a later chunk does not list it twice on the retry (review)', async () => {
    const { sdk, repo } = fresh(250)
    const q = { ...base, state: 'all' as const }
    await queryIssues(sdk, repo, { ...q, page: 2 }, 250, 'devnet')
    const documents = (sdk as unknown as { documents: { sum: (...a: unknown[]) => Promise<unknown> } }).documents
    const sum = documents.sum
    let failed = false
    documents.sum = (...a) => {
      if (!failed) {
        failed = true
        return Promise.reject(new Error('node down'))
      }
      return sum(...a)
    }
    // Pages 1-2 read the first two chunks; page 5 needs the third, whose state read fails once.
    await expect(queryIssues(sdk, repo, { ...q, page: 5 }, 250, 'devnet')).rejects.toThrow('node down')
    const p5 = await queryIssues(sdk, repo, { ...q, page: 5 }, 250, 'devnet')
    expect(p5.rows.map((r) => r.number)).toEqual(Array.from({ length: 50 }, (_, i) => 50 - i))
    const every = await queryIssues(sdk, repo, { ...q, pageSize: 300 }, 250, 'devnet')
    expect(new Set(every.rows.map((r) => r.id)).size).toBe(every.rows.length)
    expect(every.rows).toHaveLength(250)
  })

  it('reads a small repo whole in one composite', async () => {
    const { sdk, seen, repo } = fresh(12, 'Ad88NKGHimxUgGHrTGpBJjKpnzrQe8Zh4V5q13mRh85h')
    // Only #3 of the fixture's closed issues exists in a 12-issue repo.
    const page = await queryIssues(sdk, repo, base, 12, 'devnet')
    expect(page.openCount).toBe(11)
    expect(page.closedCount).toBe(1)
    expect(seen.composites).toHaveLength(1)
  })
})
