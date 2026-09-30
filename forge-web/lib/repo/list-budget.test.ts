/**
 * QW2-002: the issue and PR lists' request budget on a dash-sized repo, against the Drive-shaped
 * mock (`./drive-mock`). The dash mirror on bonsia (2026-09-30) holds 1,766 PRs (1 open, the
 * newest; 1,479 merged; 286 closed) and 320 issues (10 open among the newest 177), with ~250
 * member events; its PR list took 55–75 requests, reading every PR on every load. A page's cost
 * must not grow with the repo: here the same pages on 1,766 and 6,900 PRs (the size the import
 * is heading for) are held to one bound, cold.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { ForgeIds } from '../deployments'
import { bytesToBase64, hexToBase64, setPlatformVersion } from '../sdk'
import type { RepoRef } from './contract'
import { mockSdk, newSeen, type Doc, type Seen, type Store } from './drive-mock'
import { queryIssues, type IssueSelection } from './issue-index'
import { invalidateRepoFeed } from './issues'
import { queryPulls, type PullSelection, type PullStateFilter } from './pull-index'
import { PAGE_CHUNKS } from './target-index'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' }
const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const MAINT = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const MAIN_HASH = bytesToBase64(sha256(new TextEncoder().encode('refs/heads/main')))
const id = (s: string): string => base58Encode(sha256(new TextEncoder().encode(s)))
const oid = (n: number): string => n.toString(16).padStart(40, '0')

/**
 * The list's own reads, cold, besides the base ref's history (one read per base ref per repo,
 * which a real page takes from its chrome): the three proved counts, the first chunk (composite
 * and state sum), and at most {@link PAGE_CHUNKS} more chunks; the issue list adds the feed's
 * pages for its pinned issues.
 */
const LIST_BUDGET = 3 + 2 * (1 + PAGE_CHUNKS)

interface Shape {
  readonly prs: number
  /** PR numbers (1 = the oldest) left open. */
  readonly open: (n: number, prs: number) => boolean
  readonly issues?: number
  readonly openIssues?: (n: number) => boolean
  /** Label events, spread over the newest PRs and issues. */
  readonly events?: number
}

/** A dash-shaped repo: every sixth PR closed without merging, the rest merged, but those `open`. */
function dashRepo(repoId: string, shape: Shape): Store {
  const pid = (n: number): string => id(`${repoId}:p${n}`)
  const iid = (n: number): string => id(`${repoId}:i${n}`)
  let t = 1
  const patches: Doc[] = []
  const transitions: Doc[] = []
  const tr = (target: string, n: number, targetKind: number, kind: number, delta: number): Doc => ({ $id: `t${t}`, $ownerId: MAINT, $createdAt: 9_000_000 + t++, repoId, targetId: target, targetNumber: n, targetKind, kind, delta, asAuthor: 0 })
  for (let n = 1; n <= shape.prs; n++) {
    patches.push({ $id: pid(n), $ownerId: OWNER, $createdAt: 1_000_000 + n * 10, repoId, number: n, title: `PR ${n}`, body: '', baseRefName: 'refs/heads/main', baseRefNameHash: MAIN_HASH, headOid: hexToBase64(oid(n)), sourceRepoId: repoId })
    if (shape.open(n, shape.prs)) continue
    if (n % 6 === 0) transitions.push(tr(pid(n), n, 1, 11, 1))
    else transitions.push(tr(pid(n), n, 1, 13, 2))
  }
  const issues: Doc[] = []
  for (let n = 1; n <= (shape.issues ?? 0); n++) {
    issues.push({ $id: iid(n), $ownerId: OWNER, $createdAt: 500_000 + n * 10, repoId, number: 10_000 + n, title: `Issue ${n}`, body: '' })
    if (!(shape.openIssues?.(n) ?? false)) transitions.push(tr(iid(n), 10_000 + n, 0, 1, 1))
  }
  const events: Doc[] = []
  for (let k = 0; k < (shape.events ?? 0); k++) {
    const pr = k % 2 === 0
    const n = pr ? shape.prs - k : (shape.issues ?? 0) - k
    if (n < 1) continue
    events.push({ $id: `e${t}`, $ownerId: MAINT, $createdAt: 9_000_000 + t++, repoId, targetId: pr ? pid(n) : iid(n), targetNumber: n, kind: 4, value: 'bug' })
  }
  return {
    COLLAB: { patch: patches, issue: issues, transition: transitions, comment: [] },
    COMMUNITY: { event: events },
    CORE: {
      label: [{ $id: 'l1', $createdAt: 1, repoId, name: 'bug', color: '#d73a4a' }],
      config: [{ $id: 'cfg', $ownerId: OWNER, $createdAt: 5, repoId, defaultBranch: 'main', protectedPatterns: [] }],
      refUpdate: [{ $id: 'r0', $ownerId: OWNER, $createdAt: 10, repoId, refName: 'refs/heads/main', refNameHash: MAIN_HASH, newOid: hexToBase64(oid(99_999)) }],
      protectedRefUpdate: [],
    },
  }
}

const NEWEST_OPEN = (n: number, prs: number): boolean => n === prs
const DASH: Shape = { prs: 1766, open: NEWEST_OPEN, issues: 320, openIssues: (n) => [316, 268, 267, 246, 234, 230, 223, 216, 198, 144].includes(n), events: 250 }

let repos = 0
function fresh(shape: Shape) {
  const repoId = id(`repo${repos++}`)
  // A repo id of its own: nothing is cached for it, and no write of this browser's is recent.
  const repo: RepoRef = { forge: FORGE, repoId, ownerId: OWNER, name: 'dash', visibility: 'public' }
  const seen: Seen = newSeen()
  const store = dashRepo(repoId, shape)
  return { sdk: mockSdk(store, seen), seen, repo, store }
}

/** The list's reads: every request but the base ref's history (see {@link LIST_BUDGET}). */
function listReads(seen: Seen): number {
  const history = seen.queries.filter((q) => ['refUpdate', 'protectedRefUpdate', 'config'].includes(q.documentTypeName)).length
  return seen.composites.length + seen.queries.length + seen.counts.length + seen.sums.length - history
}

const pulls: PullSelection = { state: 'open', labels: [], author: null, assignee: null, sort: 'newest', text: '', page: 1, pageSize: 25 }
const issues: IssueSelection = { state: 'open', labels: [], author: null, assignee: null, mentions: null, sort: 'newest', text: '', page: 1, pageSize: 50 }

beforeAll(() => setPlatformVersion(14))

describe('list request budget on a dash-sized repo (QW2-002)', () => {
  for (const prs of [1766, 6900]) {
    for (const state of ['open', 'merged', 'closed', 'all'] as PullStateFilter[]) {
      it(`the ${state} PR tab's page 1, cold, on ${prs} PRs: at most ${LIST_BUDGET} list reads`, async () => {
        const { sdk, seen, repo } = fresh({ ...DASH, prs })
        const page = await queryPulls(sdk, repo, { ...pulls, state }, prs, 'devnet')
        expect(listReads(seen)).toBeLessThanOrEqual(LIST_BUDGET)
        // Never a read of the whole feed or of a tab's every transition on page 1.
        expect(seen.queries.filter((q) => q.documentTypeName === 'event' || q.documentTypeName === 'transition')).toEqual([])
        const closed = Array.from({ length: prs }, (_, k) => k + 1).filter((n) => n % 6 === 0 && !NEWEST_OPEN(n, prs)).length
        const counts = { open: 1, merged: prs - 1 - closed, closed }
        expect(page.counts).toEqual(counts)
        const want = state === 'all' ? prs : counts[state]
        expect(page.rows).toHaveLength(Math.min(25, want))
        expect(page.matching).toBe(want)
        expect(page.searchedOf).toBeNull()
        // Newest first, each in the tab.
        const numbers = page.rows.map((r) => r.number)
        expect(numbers).toEqual([...numbers].sort((a, b) => b - a))
        if (state === 'open') expect(numbers).toEqual([prs])
        if (state === 'merged') expect(page.rows.every((r) => r.state.merged)).toBe(true)
        if (state === 'closed') expect(page.rows.every((r) => !r.state.open && !r.state.merged)).toBe(true)
        expect(page.stateComplete).toBe(true)
      })
    }
  }

  it('the Open tab holds the one open PR after the first chunk, and stops there (its proved count)', async () => {
    const { sdk, seen, repo } = fresh(DASH)
    const page = await queryPulls(sdk, repo, pulls, DASH.prs, 'devnet')
    expect(page.rows.map((r) => r.number)).toEqual([1766])
    expect(page.hasNext).toBe(false)
    expect(seen.composites).toHaveLength(1)
    expect(seen.sums).toHaveLength(1)
  })

  it("page 2 of the Merged tab, and each tab after another, reads no more than a page's worth", async () => {
    const { sdk, seen, repo } = fresh(DASH)
    await queryPulls(sdk, repo, { ...pulls, state: 'merged' }, DASH.prs, 'devnet')
    const p2 = await queryPulls(sdk, repo, { ...pulls, state: 'merged', page: 2 }, DASH.prs, 'devnet')
    expect(p2.rows).toHaveLength(25)
    expect(p2.hasNext).toBe(true)
    const before = listReads(seen)
    // Warm: the tabs share the index, so switching tabs reads only what the new tab lacks.
    for (const state of ['open', 'closed', 'all', 'merged'] as PullStateFilter[]) await queryPulls(sdk, repo, { ...pulls, state }, DASH.prs, 'devnet')
    expect(listReads(seen) - before).toBeLessThanOrEqual(2 * PAGE_CHUNKS)
  })

  it('a sparse tab whose rows are old: an empty page reads on with its progress; a partial one stops at its budget and reads on when asked', async () => {
    // 36 open PRs: six in the middle (#600-#605), thirty among the oldest.
    const shape: Shape = { ...DASH, open: (n) => n <= 30 || (n >= 600 && n < 606) }
    const { sdk, seen, repo } = fresh(shape)
    const progress: number[] = []
    const first = await queryPulls(sdk, repo, pulls, shape.prs, 'devnet', { onProgress: (n) => progress.push(n) })
    // Nothing in the newest four chunks: the page read on (as a search does) until it had a row,
    // then stopped rather than walk to the oldest thirty.
    expect(first.rows.map((r) => r.number)).toEqual([605, 604, 603, 602, 601, 600])
    expect(progress.length).toBeGreaterThan(PAGE_CHUNKS)
    expect(listReads(seen)).toBeLessThanOrEqual(3 + 2 * 30)
    expect(first.counts.open).toBe(36)
    expect(first.matching).toBe(36) // the proved count: "Page 1 of 2"
    expect(first.searchedOf).toMatchObject({ more: true, total: shape.prs })
    // Each "look through older" is the same query again: another chunk budget, from where the last stopped.
    let page = first
    let loads = 1
    for (; page.searchedOf?.more === true && loads < 20; loads++) {
      const reads = listReads(seen)
      page = await queryPulls(sdk, repo, pulls, shape.prs, 'devnet')
      expect(listReads(seen) - reads).toBeLessThanOrEqual(2 * PAGE_CHUNKS)
    }
    expect(loads).toBeLessThan(6)
    expect(page.rows.map((r) => r.number)).toEqual([605, 604, 603, 602, 601, 600, ...Array.from({ length: 19 }, (_, k) => 30 - k)])
    expect(page.hasNext).toBe(true)
    expect(page.matching).toBe(36)
    expect(page.searchedOf).toBeNull()
  })

  it('a sort by comments over a tab its proved count shows held reads no further and claims no partial search', async () => {
    const { sdk, seen, repo } = fresh(DASH)
    const page = await queryPulls(sdk, repo, { ...pulls, sort: 'comments' }, DASH.prs, 'devnet')
    expect(page.rows.map((r) => r.number)).toEqual([1766])
    expect(page.searchedOf).toBeNull()
    expect(seen.composites).toHaveLength(1)
  })

  it('a page that fills on its last budget chunk keeps its proved page count', async () => {
    // Merged page 13 needs 326 merged PRs: about 390 rows, the first chunk and three more.
    const { sdk, seen, repo } = fresh(DASH)
    const page = await queryPulls(sdk, repo, { ...pulls, state: 'merged', page: 13 }, DASH.prs, 'devnet')
    expect(seen.composites).toHaveLength(1 + PAGE_CHUNKS)
    expect(page.rows).toHaveLength(25)
    expect(page.matching).toBe(page.counts.merged)
    expect(page.searchedOf).toBeNull()
  })

  it("right after this browser's own write, the walk does not stop at a count that may lag it", async () => {
    const { sdk, seen, repo } = fresh(DASH)
    // A reopen, say: a node a block behind may still count one open PR where there are two.
    invalidateRepoFeed(repo)
    const now = Date.now()
    const page = await queryPulls(sdk, repo, pulls, DASH.prs, 'devnet')
    expect(page.rows.map((r) => r.number)).toEqual([1766])
    expect(seen.composites).toHaveLength(1 + PAGE_CHUNKS) // read to its budget instead
    // An empty tab then (the last open PR just closed) still reads only its budget, not on to 30 chunks.
    const none = fresh({ ...DASH, open: () => false })
    invalidateRepoFeed(none.repo)
    const empty = await queryPulls(none.sdk, none.repo, pulls, DASH.prs, 'devnet')
    expect(empty.rows).toEqual([])
    expect(none.seen.composites).toHaveLength(1 + PAGE_CHUNKS)
    // Once the lag window has passed, the proved count stops the walk again.
    const later = vi.spyOn(Date, 'now').mockReturnValue(now + 60_000)
    try {
      const { sdk: sdk2, seen: seen2, repo: repo2 } = fresh(DASH)
      await queryPulls(sdk2, repo2, pulls, DASH.prs, 'devnet')
      expect(seen2.composites).toHaveLength(1)
    } finally {
      later.mockRestore()
    }
  })

  it('the Open and Closed issue tabs, cold: the list, its proved counts and the pinned issues within budget', async () => {
    for (const state of ['open', 'closed', 'all'] as const) {
      const { sdk, seen, repo } = fresh(DASH)
      const page = await queryIssues(sdk, repo, { ...issues, state }, DASH.issues ?? 0, 'devnet')
      // The pinned issues read the feed (250 events: its first page rides the first composite, two more follow).
      const feedPages = seen.queries.filter((q) => q.documentTypeName === 'event').length
      expect(feedPages).toBeLessThanOrEqual(2)
      expect(listReads(seen) - feedPages).toBeLessThanOrEqual(LIST_BUDGET)
      expect(page.openCount).toBe(10)
      expect(page.closedCount).toBe(310)
      if (state === 'open') expect(page.rows.map((r) => r.number - 10_000)).toEqual([316, 268, 267, 246, 234, 230, 223, 216, 198, 144])
      else expect(page.rows).toHaveLength(50)
      expect(page.matching).toBe(state === 'open' ? 10 : state === 'closed' ? 310 : 320)
      expect(page.stateComplete).toBe(true)
    }
  })

  it("a row's labels come from its own events, with no feed read; a label filter reads the feed", async () => {
    const { sdk, seen, repo } = fresh(DASH)
    const all = await queryPulls(sdk, repo, { ...pulls, state: 'all' }, DASH.prs, 'devnet')
    expect(all.rows.find((r) => r.number === 1766)?.state.labels).toEqual(['bug'])
    expect(all.rows.find((r) => r.number === 1765)?.state.labels).toEqual([])
    expect(seen.queries.filter((q) => q.documentTypeName === 'event')).toEqual([])
    const bug = await queryPulls(sdk, repo, { ...pulls, state: 'all', labels: ['bug'], pageSize: 200 }, DASH.prs, 'devnet')
    expect(bug.rows).toHaveLength(125)
    expect(bug.counts.merged! + bug.counts.closed! + bug.counts.open!).toBe(125)
    expect(seen.queries.filter((q) => q.documentTypeName === 'event').length).toBeGreaterThan(0)
  })

  it("reads a page's labels by target when a chunk's events outgrow its lookup", async () => {
    // 150 label churn events on each of the newest 3 PRs (each ends with only `kept`): the first
    // chunk's lookup comes back full, so its rows' events are read for the page.
    const shape: Shape = { ...DASH, events: 0 }
    const { seen, repo, store } = fresh(shape)
    let t = 0
    for (const n of [1766, 1765, 1764]) {
      const churn = (kind: number, value: string): Doc => ({ $id: `c${t}`, $ownerId: MAINT, $createdAt: 20_000_000 + t++, repoId: repo.repoId, targetId: id(`${repo.repoId}:p${n}`), targetNumber: n, kind, value })
      for (let k = 0; k < 150; k++) store.COMMUNITY!.event!.push(churn(k % 2 === 0 ? 4 : 5, 'churn'))
      store.COMMUNITY!.event!.push(churn(4, 'kept'))
    }
    const page = await queryPulls(mockSdk(store, seen), repo, { ...pulls, state: 'all' }, shape.prs, 'devnet')
    for (const n of [1766, 1765, 1764]) expect(page.rows.find((r) => r.number === n)?.state.labels).toEqual(['kept'])
    expect(page.stateComplete).toBe(true)
    // By target: `targetId in` the page's rows, split where a read comes back full; never the feed.
    const eventReads = seen.queries.filter((q) => q.documentTypeName === 'event')
    expect(eventReads.length).toBeGreaterThan(0)
    expect(eventReads.every((q) => q.where?.[0]?.[0] === 'targetId')).toBe(true)
    expect(eventReads.length).toBeLessThanOrEqual(16)
  })

  it('a search walks further than a page load, telling its progress chunk by chunk', async () => {
    const { sdk, repo } = fresh(DASH)
    const progress: number[] = []
    const page = await queryPulls(sdk, repo, { ...pulls, state: 'all', text: '"PR 3"' }, DASH.prs, 'devnet', { onProgress: (n) => progress.push(n) })
    expect(progress.length).toBeGreaterThan(PAGE_CHUNKS)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(page.rows.length).toBe(25)
    expect(page.rows.map((r) => r.number)).toEqual(Array.from({ length: 25 }, (_, k) => 399 - k))
  })

  it("a search on a dense tab walks (with progress) rather than resolving the tab's every transition", async () => {
    const { sdk, seen, repo } = fresh(DASH)
    const progress: number[] = []
    const page = await queryPulls(sdk, repo, { ...pulls, state: 'merged', text: '"PR 3"' }, DASH.prs, 'devnet', { onProgress: (n) => progress.push(n) })
    expect(page.rows.map((r) => r.number)).toEqual(Array.from({ length: 30 }, (_, k) => 399 - k).filter((n) => n % 6 !== 0).slice(0, 25))
    expect(progress.length).toBeGreaterThan(0)
    expect(seen.queries.filter((q) => q.documentTypeName === 'transition')).toEqual([])
  })
})
