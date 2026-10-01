/**
 * QW2-002, QW3-002/003/004/019: the issue and PR lists' request budget on a dash-sized repo,
 * against the Drive-shaped mock (`./drive-mock`). A page's cost must not grow with the repo.
 *
 * The fixture is shaped like the dash mirror on bonsia, measured 2026-09-30 (wave 3): 5,615
 * issues and PRs numbered densely in creation order (704 issues, 4,911 PRs: 8 open, 4,309 merged,
 * 594 closed; 97 open issues), each closed or merged one's state change written just after it
 * (the import), the 8 open PRs at numbers 0, 1, 4, 7, 9, 63, 667 and 1,011 below the newest (the
 * shape that left the Open tab at "8 Open" with 6 rows and 37 "Look through older" clicks), and
 * a member-event feed of thousands of label events (the pinned issues read all of it, 7-9
 * requests). The same pages are held to one bound at today's size, at the import's 7,700 and at
 * 15,000.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { ForgeIds } from '../deployments'
import { bytesToBase64, hexToBase64, setPlatformVersion } from '../sdk'
import type { RepoRef } from './contract'
import { mockSdk, newSeen, type Doc, type Seen, type Store } from './drive-mock'
import { queryIssues, type IssueListPage, type IssueSelection } from './issue-index'
import { PIN_FEED_PAGES, invalidateRepoFeed } from './issues'
import { queryPulls, type PullListPage, type PullSelection, type PullStateFilter } from './pull-index'
import { PAGE_CHUNKS, SCAN_PAGES_PER_LOAD } from './target-index'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' }
const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const MAINT = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const MAIN_HASH = bytesToBase64(sha256(new TextEncoder().encode('refs/heads/main')))
const id = (s: string): string => base58Encode(sha256(new TextEncoder().encode(s)))
const oid = (n: number): string => n.toString(16).padStart(40, '0')

/**
 * The list's own reads, cold, besides the base ref's history (one read per base ref per repo,
 * which a real page takes from its chrome): the three proved counts, the first chunk (composite
 * and state sum), and at most {@link PAGE_CHUNKS} more chunks.
 */
const LIST_BUDGET = 3 + 2 * (1 + PAGE_CHUNKS)

interface Shape {
  /** Issues and PRs, numbered 1..items in creation order (`dense`). */
  readonly items: number
  /** Which numbers are issues (the rest are PRs). */
  readonly isIssue: (n: number) => boolean
  /** Open PRs, by how far below the newest number they sit (an issue's number moves it one down). */
  readonly openPrDepths: readonly number[]
  readonly openIssue: (n: number) => boolean
  /** Label events, on the newest items, and one pin on an issue among the oldest of them. */
  readonly events?: number
  /** Items whose state change came long after them (a sync that closed an old PR later): a dozen, spread through history. */
  readonly late?: boolean
  /** The deepest open PR was closed and reopened lately (default). */
  readonly reopenDeepest?: boolean
}

/** dash's issues are about one number in eight; every seventh of them is open. */
const DASH: Shape = {
  items: 5615,
  isIssue: (n) => n % 8 === 3,
  openPrDepths: [0, 1, 4, 7, 9, 63, 667, 1011],
  openIssue: (n) => n % 56 === 3,
  events: 450,
  late: true,
}

interface Repo {
  readonly sdk: ReturnType<typeof mockSdk>
  readonly seen: Seen
  readonly repo: RepoRef
  readonly store: Store
  readonly openPrs: number[]
  readonly prs: number
  readonly issues: number
  readonly counts: { open: number; merged: number; closed: number }
  readonly openIssues: number
  readonly pinned: number
  /** PRs carrying the `bug` label. */
  readonly labelledPrs: number
}

let repos = 0
function fresh(shape: Shape): Repo {
  const repoId = id(`repo${repos++}`)
  // A repo id of its own: nothing is cached for it, and no write of this browser's is recent.
  const repo: RepoRef = { forge: FORGE, repoId, ownerId: OWNER, name: 'dash', visibility: 'public' }
  const seen: Seen = newSeen()
  const tid = (n: number): string => id(`${repoId}:${n}`)
  const at = (n: number): number => 1_000_000 + n * 10
  const openPrs = new Set<number>()
  for (const d of shape.openPrDepths) {
    let n = shape.items - d
    while (shape.isIssue(n) || openPrs.has(n)) n--
    openPrs.add(n)
  }
  const patches: Doc[] = []
  const issues: Doc[] = []
  const transitions: Doc[] = []
  let t = 0
  let lateAt = 50_000_000
  const tr = (n: number, kind: number, delta: number, when: number): void => {
    transitions.push({ $id: id(`${repoId}:t${t++}`), $ownerId: MAINT, $createdAt: when, repoId, targetId: tid(n), targetNumber: n, targetKind: Math.floor(kind / 10), kind, delta, asAuthor: 0 })
  }
  const counts = { open: 0, merged: 0, closed: 0 }
  let openIssues = 0
  let prCount = 0
  for (let n = 1; n <= shape.items; n++) {
    const when = shape.late === true && n % Math.floor(shape.items / 12) === 17 ? lateAt++ : at(n) + 5
    if (shape.isIssue(n)) {
      issues.push({ $id: tid(n), $ownerId: OWNER, $createdAt: at(n), repoId, number: n, title: `Issue ${n}`, body: '' })
      if (shape.openIssue(n)) openIssues++
      else tr(n, 1, 1, when)
      continue
    }
    prCount++
    patches.push({ $id: tid(n), $ownerId: OWNER, $createdAt: at(n), repoId, number: n, title: `PR ${n}`, body: '', baseRefName: 'refs/heads/main', baseRefNameHash: MAIN_HASH, headOid: hexToBase64(oid(n)), sourceRepoId: repoId })
    if (openPrs.has(n)) {
      counts.open++
      continue
    }
    if (prCount % 8 === 0) {
      counts.closed++
      tr(n, 11, 1, when)
    } else {
      counts.merged++
      tr(n, 13, 2, when)
    }
  }
  // The deepest open PR was closed and reopened later (its newest state change opens it).
  if (shape.reopenDeepest !== false) {
    const deepest = Math.min(...openPrs)
    tr(deepest, 11, 1, lateAt++)
    tr(deepest, 12, -1, lateAt++)
  }
  const events: Doc[] = []
  let pinned = 0
  let labelledPrs = 0
  for (let k = 0; k < (shape.events ?? 0); k++) {
    const n = shape.items - 3 * k
    if (!shape.isIssue(n)) labelledPrs++
    events.push({ $id: id(`${repoId}:e${k}`), $ownerId: MAINT, $createdAt: at(n) + 7, repoId, targetId: tid(n), targetNumber: n, kind: 4, value: 'bug' })
  }
  if ((shape.events ?? 0) > 0) {
    // A pin on an old issue, early in the feed: only the whole feed finds it.
    let n = 40
    while (!shape.isIssue(n)) n++
    pinned = n
    events.push({ $id: id(`${repoId}:pin`), $ownerId: MAINT, $createdAt: at(n) + 8, repoId, targetId: tid(n), targetNumber: n, kind: 19 })
  }
  const store: Store = {
    COLLAB: { patch: patches, issue: issues, transition: transitions, comment: [] },
    COMMUNITY: { event: events },
    CORE: {
      label: [{ $id: 'l1', $createdAt: 1, repoId, name: 'bug', color: '#d73a4a' }],
      config: [{ $id: 'cfg', $ownerId: OWNER, $createdAt: 5, repoId, defaultBranch: 'main', protectedPatterns: [] }],
      refUpdate: [{ $id: 'r0', $ownerId: OWNER, $createdAt: 10, repoId, refName: 'refs/heads/main', refNameHash: MAIN_HASH, newOid: hexToBase64(oid(99_999)) }],
      protectedRefUpdate: [],
    },
  }
  return {
    sdk: mockSdk(store, seen),
    seen,
    repo,
    store,
    openPrs: [...openPrs].sort((a, b) => b - a),
    prs: prCount,
    issues: issues.length,
    counts,
    openIssues,
    pinned,
    labelledPrs,
  }
}

/** The list's reads: every request but the base ref's history (see {@link LIST_BUDGET}). */
function listReads(seen: Seen): number {
  const history = seen.queries.filter((q) => ['refUpdate', 'protectedRefUpdate', 'config'].includes(q.documentTypeName)).length
  return seen.composites.length + seen.queries.length + seen.counts.length + seen.sums.length - history
}

/** State-scan reads: the transition feed, newest first. */
function scanReads(seen: Seen): number {
  return seen.queries.filter((q) => q.documentTypeName === 'transition' && q.orderBy?.[0]?.[0] === '$createdAt').length
}

const pulls: PullSelection = { state: 'open', labels: [], author: null, assignee: null, sort: 'newest', text: '', page: 1, pageSize: 25 }
const issues: IssueSelection = { state: 'open', labels: [], author: null, assignee: null, mentions: null, sort: 'newest', text: '', page: 1, pageSize: 50 }

/** A list page cold, then each load the page makes by itself (`searchedOf.auto`) until it settles. */
async function settledPulls(r: Repo, q: PullSelection): Promise<{ page: PullListPage; loads: number }> {
  let page = await queryPulls(r.sdk, r.repo, q, r.prs, 'devnet')
  let loads = 1
  for (; page.searchedOf?.auto === true && loads < 50; loads++) page = await queryPulls(r.sdk, r.repo, q, r.prs, 'devnet')
  return { page, loads }
}

async function settledIssues(r: Repo, q: IssueSelection): Promise<{ page: IssueListPage; loads: number }> {
  let page = await queryIssues(r.sdk, r.repo, q, r.issues, 'devnet')
  let loads = 1
  for (; page.searchedOf?.auto === true && loads < 50; loads++) page = await queryIssues(r.sdk, r.repo, q, r.issues, 'devnet')
  return { page, loads }
}

beforeAll(() => setPlatformVersion(14))

describe('list request budget on a dash-sized repo (QW2-002, QW3-003)', () => {
  for (const items of [5615, 7700, 15_000]) {
    for (const state of ['merged', 'closed', 'all', 'unmerged'] as const) {
      it(`the ${state} PR tab's page 1, cold, on ${items} issues and PRs: at most ${LIST_BUDGET} list reads`, async () => {
        const r = fresh({ ...DASH, items })
        const { page, loads } = await settledPulls(r, { ...pulls, state })
        expect(loads).toBe(1)
        expect(listReads(r.seen)).toBeLessThanOrEqual(LIST_BUDGET)
        // Never a read of the whole feed or of a tab's every transition on page 1.
        expect(r.seen.queries.filter((q) => q.documentTypeName === 'event' || q.documentTypeName === 'transition')).toEqual([])
        expect(page.counts).toEqual(r.counts)
        const want = state === 'all' ? r.prs : state === 'unmerged' ? r.counts.open + r.counts.closed : r.counts[state]
        expect(page.rows).toHaveLength(25)
        expect(page.matching).toBe(want)
        expect(page.searchedOf).toBeNull()
        const numbers = page.rows.map((x) => x.number)
        expect(numbers).toEqual([...numbers].sort((a, b) => b - a))
        if (state === 'merged') expect(page.rows.every((x) => x.state.merged)).toBe(true)
        if (state === 'closed') expect(page.rows.every((x) => !x.state.open && !x.state.merged)).toBe(true)
        if (state === 'unmerged') expect(page.rows.every((x) => !x.state.merged)).toBe(true)
        expect(page.stateComplete).toBe(true)
      })
    }

    it(`QW3-002: the Open PR tab lists every open PR its count reports, cold, on ${items}: by the state scan, the same cost at any size`, async () => {
      const r = fresh({ ...DASH, items })
      const { page, loads } = await settledPulls(r, pulls)
      // Every open PR, newest first, the deepest (closed and reopened) included; no page to click through.
      expect(page.rows.map((x) => x.number)).toEqual(r.openPrs)
      expect(page.counts.open).toBe(8)
      expect(page.matching).toBe(8)
      expect(page.hasNext).toBe(false)
      expect(page.searchedOf).toBeNull()
      expect(loads).toBe(1)
      // The first chunk, then light state-change reads down past the open PR 667 numbers down (the
      // deepest, 1,011 down, was reopened lately: its reopen names it on the first page), and the
      // numbers they name read by number in two batches, their states proved by the scan (one sum:
      // the first chunk's). Measured 15: 3 counts, 2 for the first chunk, 8 scan pages, 2 batches.
      expect(scanReads(r.seen)).toBeLessThanOrEqual(9)
      expect(r.seen.composites.length).toBeLessThanOrEqual(1 + 2)
      expect(r.seen.sums).toHaveLength(1)
      expect(listReads(r.seen)).toBeLessThanOrEqual(16)
    })
  }

  it('an Open tab whose deepest open PR was never closed reads down to it (dash today: 1,011 numbers down)', async () => {
    const r = fresh({ ...DASH, reopenDeepest: false })
    const { page, loads } = await settledPulls(r, pulls)
    expect(page.rows.map((x) => x.number)).toEqual(r.openPrs)
    expect(loads).toBe(1)
    // About 1,010 state changes above it: 11 scan pages, and a batch read every 4 of them.
    expect(scanReads(r.seen)).toBeLessThanOrEqual(12)
    expect(r.seen.composites.length).toBeLessThanOrEqual(1 + 3)
    expect(listReads(r.seen)).toBeLessThanOrEqual(3 + 2 + 12 + 3 + 1)
  })

  it('a tab whose rows are the oldest: the scan reads to the start, proves page 1 by its count, and page 2 reads no further', async () => {
    // 30 open PRs among the oldest 40 numbers of 1,500.
    const r = fresh({ ...DASH, items: 1500, openPrDepths: Array.from({ length: 30 }, (_, k) => 1460 + k), reopenDeepest: false })
    const { page } = await settledPulls(r, pulls)
    expect(page.rows.map((x) => x.number)).toEqual(r.openPrs.slice(0, 25))
    expect(page.matching).toBe(30)
    expect(page.hasNext).toBe(true)
    const reads = listReads(r.seen)
    const p2 = await queryPulls(r.sdk, r.repo, { ...pulls, page: 2 }, r.prs, 'devnet')
    expect(p2.rows.map((x) => x.number)).toEqual(r.openPrs.slice(25))
    expect(p2.hasNext).toBe(false)
    // The scan is done: page 2 only reads the rows it names.
    expect(listReads(r.seen) - reads).toBeLessThanOrEqual(1)
  })

  it("after the Open tab's scan, a dense tab still reads its page from the rows it holds", async () => {
    const r = fresh({ ...DASH, reopenDeepest: false })
    await settledPulls(r, pulls)
    const before = listReads(r.seen)
    const all = await queryPulls(r.sdk, r.repo, { ...pulls, state: 'all' }, r.prs, 'devnet')
    expect(all.rows).toHaveLength(25)
    expect(all.searchedOf).toBeNull()
    expect(listReads(r.seen)).toBe(before)
  })

  it('the Open tab costs what the depth of its oldest open PR costs, not what the repo holds', async () => {
    const reads: number[] = []
    for (const items of [5615, 15_000, 30_000]) {
      const r = fresh({ ...DASH, items })
      await settledPulls(r, pulls)
      reads.push(listReads(r.seen))
    }
    expect(Math.max(...reads) - Math.min(...reads)).toBeLessThanOrEqual(2)
  })

  it('an Open tab whose rows are all among the newest stops at its proved count after the first chunk', async () => {
    const r = fresh({ ...DASH, openPrDepths: [0, 3, 9] })
    const { page } = await settledPulls(r, pulls)
    expect(page.rows.map((x) => x.number)).toEqual(r.openPrs)
    expect(r.seen.composites).toHaveLength(1)
    expect(r.seen.sums).toHaveLength(1)
    expect(scanReads(r.seen)).toBe(0)
  })

  it('an Open tab whose oldest open PR is deeper than one load reads on by itself, showing what it found so far', async () => {
    // One open PR 4,000 numbers down: past one load's scan pages.
    const r = fresh({ ...DASH, openPrDepths: [0, 2, 4000], reopenDeepest: false })
    const first = await queryPulls(r.sdk, r.repo, pulls, r.prs, 'devnet')
    expect(first.rows.map((x) => x.number)).toEqual(r.openPrs.slice(0, 2))
    expect(first.matching).toBe(3)
    expect(first.searchedOf).toMatchObject({ kind: 'scan', auto: true, more: true, total: r.prs })
    expect(scanReads(r.seen)).toBe(SCAN_PAGES_PER_LOAD)
    const { page, loads } = await settledPulls(r, pulls)
    expect(page.rows.map((x) => x.number)).toEqual(r.openPrs)
    expect(page.searchedOf).toBeNull()
    expect(loads).toBeLessThanOrEqual(3)
  })

  it('the oldest-first Open tab finds every open PR through the scan too, oldest first', async () => {
    // Before: 104 requests and 465 s on bonsia (31 chunks from the oldest PR), with no row shown.
    const r = fresh(DASH)
    const { page } = await settledPulls(r, { ...pulls, sort: 'oldest' })
    expect(page.rows.map((x) => x.number)).toEqual([...r.openPrs].reverse())
    expect(scanReads(r.seen)).toBeLessThanOrEqual(12)
    expect(listReads(r.seen)).toBeLessThanOrEqual(20)
  })

  it('a state change written long after its PR (a later sync) is read where it lands, not where the PR sits', async () => {
    // Every 500th number's state change is at the end of history: the scan reads those first.
    const r = fresh(DASH)
    const { page } = await settledPulls(r, { ...pulls, state: 'closed' })
    expect(page.rows.every((x) => !x.state.open && !x.state.merged)).toBe(true)
    const open = await settledPulls(r, pulls)
    expect(open.page.rows.map((x) => x.number)).toEqual(r.openPrs)
  })

  it("page 2 of the Merged tab, and each tab after another, reads no more than a page's worth", async () => {
    const r = fresh(DASH)
    await queryPulls(r.sdk, r.repo, { ...pulls, state: 'merged' }, r.prs, 'devnet')
    const p2 = await queryPulls(r.sdk, r.repo, { ...pulls, state: 'merged', page: 2 }, r.prs, 'devnet')
    expect(p2.rows).toHaveLength(25)
    expect(p2.hasNext).toBe(true)
    const before = listReads(r.seen)
    // Warm: the tabs share the index, so switching tabs reads only what the new tab lacks.
    for (const state of ['closed', 'all', 'merged'] as PullStateFilter[]) await queryPulls(r.sdk, r.repo, { ...pulls, state }, r.prs, 'devnet')
    expect(listReads(r.seen) - before).toBeLessThanOrEqual(2 * PAGE_CHUNKS)
  })

  it('QW3-004: a sort by comments reads one load\'s chunks, says how far, and reads on when asked', async () => {
    const r = fresh(DASH)
    const page = await queryPulls(r.sdk, r.repo, { ...pulls, state: 'all', sort: 'comments' }, r.prs, 'devnet')
    expect(r.seen.composites).toHaveLength(1 + PAGE_CHUNKS)
    expect(listReads(r.seen)).toBeLessThanOrEqual(LIST_BUDGET)
    expect(page.rows).toHaveLength(25)
    expect(page.searchedOf).toMatchObject({ kind: 'sort', more: true, searched: 397, total: r.prs })
    const reads = listReads(r.seen)
    const more = await queryPulls(r.sdk, r.repo, { ...pulls, state: 'all', sort: 'comments' }, r.prs, 'devnet')
    expect(listReads(r.seen) - reads).toBeLessThanOrEqual(2 * PAGE_CHUNKS)
    expect(more.searchedOf).toMatchObject({ kind: 'sort', more: true, searched: 694 })
  })

  it('a sort by comments over a tab its proved count shows held reads no further and claims no partial sort', async () => {
    const r = fresh({ ...DASH, openPrDepths: [0, 3] })
    const page = await queryPulls(r.sdk, r.repo, { ...pulls, sort: 'comments' }, r.prs, 'devnet')
    expect(page.rows.map((x) => x.number)).toEqual(r.openPrs)
    expect(page.searchedOf).toBeNull()
    expect(r.seen.composites).toHaveLength(1)
  })

  it('a page that fills on its last budget chunk keeps its proved page count', async () => {
    // Merged page 13 needs 326 merged PRs: about 430 rows, the first chunk and three more.
    const r = fresh(DASH)
    const page = await queryPulls(r.sdk, r.repo, { ...pulls, state: 'merged', page: 13 }, r.prs, 'devnet')
    expect(r.seen.composites).toHaveLength(1 + PAGE_CHUNKS)
    expect(page.rows).toHaveLength(25)
    expect(page.matching).toBe(page.counts.merged)
    expect(page.searchedOf).toBeNull()
  })

  it("right after this browser's own write, the list does not stop at (or scan by) a count that may lag it", async () => {
    const r = fresh({ ...DASH, openPrDepths: [0, 3] })
    // A reopen, say: a node a block behind may still count one open PR where there are two.
    invalidateRepoFeed(r.repo)
    const now = Date.now()
    const page = await queryPulls(r.sdk, r.repo, pulls, r.prs, 'devnet')
    expect(page.rows.map((x) => x.number)).toEqual(r.openPrs)
    expect(r.seen.composites).toHaveLength(1 + PAGE_CHUNKS) // read to its budget instead
    expect(scanReads(r.seen)).toBe(0)
    // Once the lag window has passed, the proved count stops the walk again.
    const later = vi.spyOn(Date, 'now').mockReturnValue(now + 60_000)
    try {
      const r2 = fresh({ ...DASH, openPrDepths: [0, 3] })
      await queryPulls(r2.sdk, r2.repo, pulls, r2.prs, 'devnet')
      expect(r2.seen.composites).toHaveLength(1)
    } finally {
      later.mockRestore()
    }
  })

  for (const items of [5615, 7700, 15_000]) {
    it(`the Open, Closed and All issue tabs, cold, on ${items}: within budget, and the pinned issues only when the feed is short`, async () => {
      for (const state of ['open', 'closed', 'all'] as const) {
        const r = fresh({ ...DASH, items })
        const { page, loads } = await settledIssues(r, { ...issues, state })
        expect(loads).toBe(1)
        // The feed is 450 events: past what a page reads for its pins, so they wait to be asked for.
        const feedPages = r.seen.queries.filter((q) => q.documentTypeName === 'event').length
        expect(feedPages).toBeLessThanOrEqual(PIN_FEED_PAGES)
        expect(page.pinsUnread).toBe(true)
        expect(page.pinned).toEqual([])
        expect(listReads(r.seen) - feedPages).toBeLessThanOrEqual(LIST_BUDGET)
        expect(page.openCount).toBe(r.openIssues)
        expect(page.closedCount).toBe(r.issues - r.openIssues)
        expect(page.rows).toHaveLength(50)
        expect(page.rows.every((x) => state === 'all' || x.state.open === (state === 'open'))).toBe(true)
        expect(page.matching).toBe(state === 'open' ? r.openIssues : state === 'closed' ? r.issues - r.openIssues : r.issues)
        expect(page.searchedOf).toBeNull()
        expect(page.stateComplete).toBe(true)
      }
    })
  }

  it('a long feed is read for the pins once per index, not on every page-1 load', async () => {
    const r = fresh(DASH)
    await queryIssues(r.sdk, r.repo, issues, r.issues, 'devnet')
    const feed = (): number => r.seen.queries.filter((q) => q.documentTypeName === 'event' && q.where?.[0]?.[0] === 'repoId').length
    const once = feed()
    expect(once).toBe(PIN_FEED_PAGES)
    const again = await queryIssues(r.sdk, r.repo, { ...issues, state: 'closed' }, r.issues, 'devnet')
    expect(again.pinsUnread).toBe(true)
    expect(feed()).toBe(once)
  })

  it('asked for, the pinned issues read the whole feed and show the pin', async () => {
    const r = fresh(DASH)
    const page = await queryIssues(r.sdk, r.repo, issues, r.issues, 'devnet', { pins: true })
    expect(page.pinsUnread).toBe(false)
    expect(page.pinned.map((x) => x.number)).toEqual([r.pinned])
  })

  it('a short feed gives page 1 its pinned issues with no extra request', async () => {
    const r = fresh({ ...DASH, events: 40 })
    const page = await queryIssues(r.sdk, r.repo, issues, r.issues, 'devnet')
    expect(page.pinsUnread).toBe(false)
    expect(page.pinned.map((x) => x.number)).toEqual([r.pinned])
    expect(r.seen.queries.filter((q) => q.documentTypeName === 'event')).toEqual([])
  })

  it("a row's labels come from its own events, with no feed read; a label filter reads the feed", async () => {
    const r = fresh(DASH)
    const all = await queryPulls(r.sdk, r.repo, { ...pulls, state: 'all' }, r.prs, 'devnet')
    expect(all.rows.find((x) => x.number === r.openPrs[0])?.state.labels).toEqual(['bug'])
    expect(r.seen.queries.filter((q) => q.documentTypeName === 'event')).toEqual([])
    const bug = await queryPulls(r.sdk, r.repo, { ...pulls, state: 'all', labels: ['bug'], pageSize: 500 }, r.prs, 'devnet')
    expect(bug.rows).toHaveLength(r.labelledPrs)
    expect(r.labelledPrs).toBeGreaterThan(200)
    expect(bug.rows.every((x) => x.state.labels.includes('bug'))).toBe(true)
    expect(r.seen.queries.filter((q) => q.documentTypeName === 'event').length).toBeGreaterThan(0)
  })

  it("reads a page's labels by target when a chunk's events outgrow its lookup", async () => {
    // 150 label churn events on each of the newest 3 PRs (each ends with only `kept`): the first
    // chunk's lookup comes back full, so its rows' events are read for the page.
    const r = fresh({ ...DASH, events: 0 })
    const prs = r.openPrs.slice(0, 3)
    let t = 0
    for (const n of prs) {
      const churn = (kind: number, value: string): Doc => ({ $id: `c${t}`, $ownerId: MAINT, $createdAt: 20_000_000 + t++, repoId: r.repo.repoId, targetId: id(`${r.repo.repoId}:${n}`), targetNumber: n, kind, value })
      for (let k = 0; k < 150; k++) r.store.COMMUNITY!.event!.push(churn(k % 2 === 0 ? 4 : 5, 'churn'))
      r.store.COMMUNITY!.event!.push(churn(4, 'kept'))
    }
    const page = await queryPulls(r.sdk, r.repo, { ...pulls, state: 'all' }, r.prs, 'devnet')
    for (const n of prs) expect(page.rows.find((x) => x.number === n)?.state.labels).toEqual(['kept'])
    expect(page.stateComplete).toBe(true)
    // By target: `targetId in` the page's rows, split where a read comes back full; never the feed.
    const eventReads = r.seen.queries.filter((q) => q.documentTypeName === 'event')
    expect(eventReads.length).toBeGreaterThan(0)
    expect(eventReads.every((q) => q.where?.[0]?.[0] === 'targetId')).toBe(true)
    // A binary split per level for each churned PR among the page's 100: about 6 levels.
    expect(eventReads.length).toBeLessThanOrEqual(20)
  })

  it('QW3-019: a search reads one load\'s chunks, shows its matches, and reads on when asked', async () => {
    const r = fresh(DASH)
    const progress: number[] = []
    const q = { ...pulls, state: 'all' as const, text: '"PR 1"' }
    const first = await queryPulls(r.sdk, r.repo, q, r.prs, 'devnet', { onProgress: (n) => progress.push(n) })
    expect(r.seen.composites).toHaveLength(1 + PAGE_CHUNKS)
    expect(listReads(r.seen)).toBeLessThanOrEqual(LIST_BUDGET)
    expect(progress).toHaveLength(PAGE_CHUNKS)
    expect(first.searchedOf).toMatchObject({ more: true, searched: 397, total: r.prs })
    expect(first.rows.every((x) => x.title.includes('PR 1'))).toBe(true)
    // Reading on (the same query again) looks further, a load's chunks at a time.
    let page = first
    for (let k = 0; k < 20 && page.rows.length < 25 && page.searchedOf?.more; k++) {
      const reads = listReads(r.seen)
      page = await queryPulls(r.sdk, r.repo, q, r.prs, 'devnet')
      expect(listReads(r.seen) - reads).toBeLessThanOrEqual(2 * PAGE_CHUNKS)
    }
    expect(page.rows).toHaveLength(25)
    expect(page.rows.every((x) => x.title.includes('PR 1'))).toBe(true)
  })

  it("a search on a dense tab walks rather than resolving the tab's every transition", async () => {
    const r = fresh(DASH)
    const page = await queryPulls(r.sdk, r.repo, { ...pulls, state: 'merged', text: '"PR 55"' }, r.prs, 'devnet')
    expect(page.rows.every((x) => x.state.merged && x.title.includes('PR 55'))).toBe(true)
    expect(r.seen.queries.filter((q) => q.documentTypeName === 'transition')).toEqual([])
  })
})
