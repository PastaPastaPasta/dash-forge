/**
 * The pull index (L-44, L-77) against the Drive-shaped mock (`./drive-mock`): every composite,
 * plain, count and sum request is recorded, so each list page's request budget is asserted, not
 * assumed. States are the proved sums of each PR's transitions; the tabs' candidates are the
 * targets of the merge and close transitions; the counts are the proved totals; the feed (labels
 * and assignees) is read once per repo and shared with the issue index.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { beforeAll, describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { ForgeIds } from '../deployments'
import { bytesToBase64, hexToBase64, setPlatformVersion, type DocumentQuery } from '../sdk'
import { invalidateRepoFeed } from './issues'
import { queryIssues } from './issue-index'
import { pullsLinking, queryPulls, type PullSelection } from './pull-index'
import type { RepoRef } from './contract'
import { mockSdk, newSeen, type Doc, type Seen, type Store } from './drive-mock'
import { OUTCOME_REQUESTS, clearOutcomeCache, readOutcomeCounts } from './check-outcomes'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' }
const REPO = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const MAINT = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const COLLAB = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const AUTHOR = '7Ej2YTftCL23mVwvhviak8ZJMmpqcsVj7CU5KPxzyy4h'
const MAIN_HASH = bytesToBase64(sha256(new TextEncoder().encode('refs/heads/main')))

/** PR `n`'s document id: a real 32-byte identifier (state sums key targets by their bytes). */
const PID = (n: number): string => base58Encode(sha256(new TextEncoder().encode(`p${n}`)))
const oid = (n: number): string => n.toString(16).padStart(40, '0')

function repoRef(): RepoRef {
  return { forge: FORGE, repoId: REPO, ownerId: OWNER, name: 'demo', visibility: 'public' }
}

/**
 * `n` PRs into main, one per second. Every 10th is merged; every 7th (not 10th) closed, the 21st
 * and 42nd by their author; #14 was closed and reopened; #6 is a draft. #3 and #n are labelled
 * `bug`, #9 assigned; 150 label events on #1 make the feed longer than one page. Two issues share
 * the feed and the transitions.
 */
function bigRepo(n: number, { churn = true }: { churn?: boolean } = {}): Store {
  let t = 1_000_000
  const patches: Doc[] = []
  for (let i = 1; i <= n; i++) {
    patches.push({
      $id: PID(i),
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
  const tr = (i: number, kind: number, delta: number, extra: Doc = {}): Doc => ({ $id: `t${t}`, $ownerId: MAINT, $createdAt: t++, repoId: REPO, targetId: PID(i), targetNumber: i, targetKind: 1, kind, delta, asAuthor: 0, ...extra })
  const transitions: Doc[] = []
  for (let i = 1; i <= n; i++) {
    if (i % 10 === 0) transitions.push(tr(i, 13, 2, { oid: hexToBase64(oid(i)) }))
    else if (i % 7 === 0) transitions.push(i % 21 === 0 ? tr(i, 11, 1, { $ownerId: patches[i - 1]!['$ownerId'], asAuthor: i }) : tr(i, 11, 1))
  }
  if (n >= 14) transitions.push(tr(14, 12, -1))
  if (n >= 6) transitions.push(tr(6, 14, 8))
  transitions.push({ $id: 'tissue', $ownerId: MAINT, $createdAt: t++, repoId: REPO, targetId: 'Ad88NKGHimxUgGHrTGpBJjKpnzrQe8Zh4V5q13mRh85h', targetNumber: 1001, targetKind: 0, kind: 1, delta: 1, asAuthor: 0 })
  const ev = (i: number, kind: number, extra: Doc = {}): Doc => ({ $id: `e${t}`, $ownerId: MAINT, $createdAt: t++, repoId: REPO, targetId: PID(i), targetNumber: i, kind, ...extra })
  const events: Doc[] = [ev(3, 4, { value: 'bug' }), ev(n, 4, { value: 'bug' }), ev(9, 6, { value: MAINT, refId: MAINT })]
  if (churn) for (let k = 0; k < 150; k++) events.push(ev(1, k % 2 === 0 ? 4 : 5, { value: 'churn' }))
  return {
    COLLAB: {
      patch: patches,
      issue: [1, 2].map((i) => ({ $id: base58Encode(sha256(new TextEncoder().encode(`i${i}`))), $ownerId: AUTHOR, $createdAt: 1_500_000 + i, repoId: REPO, number: 1000 + i, title: `Issue ${i}`, body: '' })),
      transition: transitions,
      comment: [PID(n), PID(n), PID(n - 1)].map((target, k) => ({ $id: `c${k}`, $ownerId: OWNER, $createdAt: 5 + k, repoId: REPO, targetId: target })),
    },
    // RC1 layout: events (labels, assignees) live in forge-community.
    COMMUNITY: { event: events },
    CORE: {
      label: [{ $id: 'l1', $createdAt: 1, repoId: REPO, name: 'bug', color: '#d73a4a' }],
      config: [{ $id: 'cfg', $ownerId: OWNER, $createdAt: 5, repoId: REPO, defaultBranch: 'main', protectedPatterns: [] }],
      refUpdate: [{ $id: 'r0', $ownerId: OWNER, $createdAt: 10, repoId: REPO, refName: 'refs/heads/main', refNameHash: MAIN_HASH, newOid: hexToBase64(oid(99_999)) }],
      protectedRefUpdate: [],
    },
  }
}

/** {@link bigRepo}(n)'s counts: merged every 10th, closed every other 7th but #14 (reopened). */
function expected(n: number): { open: number; merged: number; closed: number } {
  let merged = 0
  let closed = 0
  for (let i = 1; i <= n; i++) {
    if (i % 10 === 0) merged++
    else if (i % 7 === 0 && i !== 14) closed++
  }
  return { open: n - merged - closed, merged, closed }
}

const base: PullSelection = { state: 'open', labels: [], author: null, assignee: null, sort: 'newest', text: '', page: 1, pageSize: 25 }

function fresh(n: number, opts?: { churn?: boolean }) {
  const seen: Seen = newSeen()
  const repo = repoRef()
  invalidateRepoFeed(repo)
  const store = bigRepo(n, opts)
  return { sdk: mockSdk(store, seen), seen, repo, store }
}

const plainOf = (seen: Seen, type: string): DocumentQuery[] => seen.queries.filter((q) => q.documentTypeName === type)
const requests = (seen: Seen): number => seen.composites.length + seen.queries.length + seen.counts.length + seen.sums.length

// Protocol 14 (moutai, bonsia): a paged read continues past its cursor without a tie probe.
beforeAll(() => setPlatformVersion(14))

describe('pull index', () => {
  it('lists the first page from one composite and one state sum, with the proved Open / Merged / Closed counts', async () => {
    const { sdk, seen, repo } = fresh(203)
    const page = await queryPulls(sdk, repo, base, 203, 'devnet')
    expect(page.rows).toHaveLength(25)
    expect(page.rows[0]?.number).toBe(202) // #203 (7 × 29) is closed
    expect(page.rows.every((r) => r.state.open)).toBe(true)
    expect(page.counts).toEqual(expected(203))
    expect(page.matching).toBe(expected(203).open) // "Page 1 of N" from the proved count
    // Budget: one composite (rows, comment counts, names, labels, first feed page), one sum for
    // the rows' states, the feed's continuation, main's history ONCE (never a read per PR), and
    // the three proved counts.
    expect(seen.composites).toHaveLength(1)
    expect(seen.sums).toHaveLength(1)
    expect(plainOf(seen, 'refUpdate')).toHaveLength(1)
    expect(plainOf(seen, 'protectedRefUpdate')).toHaveLength(1)
    expect(plainOf(seen, 'config').length).toBeLessThanOrEqual(1)
    expect(plainOf(seen, 'event').length).toBeGreaterThan(0)
    // The feed is read from forge-community (its first page as a sibling of the collab composite).
    expect(plainOf(seen, 'event').every((q) => q.dataContractId === 'COMMUNITY')).toBe(true)
    expect(seen.composites[0]?.subQueries.some((sq) => sq.documentType === 'event' && sq.dataContractId === 'COMMUNITY')).toBe(true)
    expect(seen.counts.map((q) => q.documentTypeName).sort()).toEqual(['issue', 'patch', 'transition'])
    expect(requests(seen)).toBeLessThanOrEqual(10)
    expect(page.rows.find((r) => r.number === 202)?.comments).toBe(1)
    expect(page.rows.find((r) => r.number === 6)).toBeUndefined() // not on page 1
  })

  it("adds three proved counts for the page's CI status dots, plus one run read per mixed head (O-07)", async () => {
    const { sdk, seen, repo, store } = fresh(203)
    clearOutcomeCache()
    // #202's head: one passed and one failing run (mixed, so its runs are read); #201's: one pending.
    store.COMMUNITY!.checkRun = [
      { $id: 'k1', $ownerId: MAINT, $createdAt: 1, repoId: REPO, headOid: hexToBase64(oid(202)), name: 'build', status: 'completed', conclusion: 'success', outcome: 1 },
      { $id: 'k2', $ownerId: MAINT, $createdAt: 2, repoId: REPO, headOid: hexToBase64(oid(202)), name: 'lint', status: 'completed', conclusion: 'failure', outcome: 2 },
      { $id: 'k3', $ownerId: MAINT, $createdAt: 3, repoId: REPO, headOid: hexToBase64(oid(201)), name: 'build', status: 'queued', outcome: 0 },
    ]
    const page = await queryPulls(sdk, repo, base, 203, 'devnet')
    const before = requests(seen)
    const dots = await readOutcomeCounts(sdk, repo, page.rows.map((r) => r.headOid))
    expect(requests(seen) - before).toBe(OUTCOME_REQUESTS + 1)
    expect(seen.counts.filter((q) => q.documentTypeName === 'checkRun')).toHaveLength(OUTCOME_REQUESTS)
    expect(plainOf(seen, 'checkRun')).toHaveLength(1)
    expect(dots.get(oid(202))).toEqual({ pending: 0, passed: 1, failed: 1 })
    expect(dots.get(oid(201))).toEqual({ pending: 1, passed: 0, failed: 0 })
    expect(dots.size).toBe(page.rows.length)
  })

  it('pages past 100 with keyset composites', async () => {
    const { sdk, seen, repo } = fresh(203)
    const p9 = await queryPulls(sdk, repo, { ...base, state: 'all', page: 9 }, 203, 'devnet')
    expect(p9.rows.map((r) => r.number)).toEqual([3, 2, 1])
    expect(p9.hasNext).toBe(false)
    expect(p9.matching).toBe(203)
    expect(seen.composites.filter((c) => (c.where ?? []).some(([f, op]) => f === '$createdAt' && op === '<='))).toHaveLength(2)
    expect(seen.sums).toHaveLength(3) // one per chunk of 100
  })

  it('shows the Merged and Closed tabs from their transitions, past the loaded pages, without walking', async () => {
    const { sdk, seen, repo } = fresh(203)
    const merged = await queryPulls(sdk, repo, { ...base, state: 'merged', pageSize: 100 }, 203, 'devnet')
    expect(merged.rows.map((r) => r.number)).toEqual(Array.from({ length: 20 }, (_, k) => 200 - k * 10))
    const closed = await queryPulls(sdk, repo, { ...base, state: 'closed', pageSize: 100 }, 203, 'devnet')
    expect(closed.rows.map((r) => r.number)).toContain(21) // closed by its author
    expect(closed.rows.map((r) => r.number)).not.toContain(14) // closed, then reopened
    expect(closed.rows).toHaveLength(expected(203).closed)
    expect(seen.composites.some((c) => (c.where ?? []).some(([f]) => f === '$createdAt'))).toBe(false)
    const open = await queryPulls(sdk, repo, { ...base, state: 'all', sort: 'oldest', pageSize: 100 }, 203, 'devnet')
    expect(open.rows.find((r) => r.number === 14)?.state.open).toBe(true)
  })

  it('shows a draft as open, and a transition to an issue never as a PR', async () => {
    const { sdk, repo } = fresh(30)
    const all = await queryPulls(sdk, repo, { ...base, state: 'all', pageSize: 100 }, 30, 'devnet')
    expect(all.rows.find((r) => r.number === 6)?.state).toMatchObject({ open: true, draft: true, merged: false })
    expect(all.rows.find((r) => r.number === 10)?.state.merged).toBe(true)
    expect(all.rows).toHaveLength(30)
    expect(all.counts).toEqual(expected(30))
  })

  it('filters by label, assignee, author and text, with counts under the filter', async () => {
    const { sdk, seen, repo } = fresh(203)
    const bug = await queryPulls(sdk, repo, { ...base, state: 'all', labels: ['bug'] }, 203, 'devnet')
    expect(bug.rows.map((r) => r.number)).toEqual([203, 3])
    expect(bug.counts).toEqual({ open: 1, merged: 0, closed: 1 })
    expect(bug.matching).toBe(2)
    const assigned = await queryPulls(sdk, repo, { ...base, assignee: MAINT }, 203, 'devnet')
    expect(assigned.rows.map((r) => r.number)).toEqual([9])
    const text = await queryPulls(sdk, repo, { ...base, state: 'all', text: 'parser' }, 203, 'devnet')
    expect(text.rows.map((r) => r.number)).toEqual([42])
    const byNumber = await queryPulls(sdk, repo, { ...base, state: 'all', text: '#7' }, 203, 'devnet')
    expect(byNumber.rows.map((r) => r.number)).toEqual([7])
    const mine = await queryPulls(sdk, repo, { ...base, state: 'all', author: AUTHOR, pageSize: 100 }, 203, 'devnet')
    expect(mine.rows).toHaveLength(50)
    expect(mine.rows.every((r) => r.author === AUTHOR)).toBe(true)
    expect(seen.composites.some((c) => (c.where ?? []).some(([f]) => f === '$ownerId'))).toBe(true)
  })

  it('sorts oldest first by walking ascending, and by comment count', async () => {
    const { sdk, repo } = fresh(203)
    const oldest = await queryPulls(sdk, repo, { ...base, state: 'all', sort: 'oldest' }, 203, 'devnet')
    expect(oldest.rows.slice(0, 3).map((r) => r.number)).toEqual([1, 2, 3])
    const talked = await queryPulls(sdk, repo, { ...base, state: 'all', sort: 'comments' }, 203, 'devnet')
    expect(talked.rows.slice(0, 2).map((r) => [r.number, r.comments])).toEqual([[203, 2], [202, 1]])
  })

  it('pages the repo feed once for the issue index and the pull index', async () => {
    const { sdk, seen, repo } = fresh(203)
    await Promise.all([
      queryIssues(sdk, repo, { state: 'open', labels: [], author: null, assignee: null, mentions: null, sort: 'newest', text: '', page: 1, pageSize: 50 }, 2, 'devnet'),
      queryPulls(sdk, repo, base, 203, 'devnet'),
    ])
    // The 150+ event feed: its first page rides a composite, and ONE continuation page follows.
    expect(plainOf(seen, 'event')).toHaveLength(1)
  })

  it('a read in flight across a write does not refill the shared feed (L-77 review)', async () => {
    const { sdk, seen, repo, store } = fresh(30, { churn: false })
    let release!: () => void
    seen.hold = new Promise((r) => (release = r))
    const stale = queryPulls(sdk, repo, base, 30, 'devnet')
    await Promise.resolve()
    // A maintainer labels #2 while the composite (whose feed page is from before) is held.
    store.COMMUNITY!.event!.push({ $id: 'elabel', $ownerId: MAINT, $createdAt: 9_000_000, repoId: REPO, targetId: PID(2), targetNumber: 2, kind: 4, value: 'bug' })
    invalidateRepoFeed(repo)
    seen.hold = null
    release()
    await stale
    const after = await queryPulls(sdk, repo, { ...base, labels: ['bug'] }, 30, 'devnet')
    expect(after.rows.map((r) => r.number)).toContain(2)
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

  it('a failed read on a later chunk leaves the index as it was: the retry reads it once, not twice (review)', async () => {
    const { sdk, seen, repo, store } = fresh(203)
    // #50..#1 target `dev`, whose history is read when the walk reaches them (the second chunk on).
    const DEV = bytesToBase64(sha256(new TextEncoder().encode('refs/heads/dev')))
    for (const p of store.COLLAB!.patch!) if ((p['number'] as number) <= 50) Object.assign(p, { baseRefName: 'refs/heads/dev', baseRefNameHash: DEV })
    store.CORE!.refUpdate!.push({ $id: 'rdev', $ownerId: OWNER, $createdAt: 11, repoId: REPO, refName: 'refs/heads/dev', refNameHash: DEV, newOid: hexToBase64(oid(88_888)) })
    await queryPulls(sdk, repo, { ...base, state: 'all' }, 203, 'devnet')
    // `dev`'s history read fails once (a node down): the page fails…
    const documents = (sdk as unknown as { documents: { query: (q: DocumentQuery) => Promise<unknown> } }).documents
    const query = documents.query
    let failed = false
    documents.query = (q) => {
      if (!failed && q.documentTypeName === 'refUpdate' && (q.where ?? []).some(([f, , v]) => f === 'refNameHash' && v === DEV)) {
        failed = true
        return Promise.reject(new Error('node down'))
      }
      return query(q)
    }
    await expect(queryPulls(sdk, repo, { ...base, state: 'all', page: 9 }, 203, 'devnet')).rejects.toThrow('node down')
    // …and the retry reads `dev` again (the failure is not kept) and lists every PR once.
    const last = await queryPulls(sdk, repo, { ...base, state: 'all', page: 9 }, 203, 'devnet')
    expect(last.rows.map((r) => r.number)).toEqual([3, 2, 1])
    const all = await queryPulls(sdk, repo, { ...base, state: 'all', pageSize: 300 }, 203, 'devnet')
    expect(all.rows).toHaveLength(203)
    expect(new Set(all.rows.map((r) => r.id)).size).toBe(203)
    // `dev`'s history was asked for twice: the failure, then the retry (the failure was not kept).
    const devReads = seen.queries.filter((q) => q.documentTypeName === 'refUpdate' && (q.where ?? []).some(([f, , v]) => f === 'refNameHash' && v === DEV))
    expect(devReads).toHaveLength(1) // the failed call never reached the store; the retry did
    expect(failed).toBe(true)
  })

  it('leaves a hidden PR out of Open only while it is open (review)', async () => {
    const { sdk, repo, store } = fresh(30)
    // Two malformed PRs (ciphertext in a public repo): #31 still open, #32 closed by a maintainer.
    for (const n of [31, 32]) store.COLLAB!.patch!.push({ $id: PID(n), $ownerId: COLLAB, $createdAt: 2_000_000 + n * 1000, repoId: REPO, number: n, title: '', enc: bytesToBase64(new Uint8Array(32)), epoch: 0, baseRefName: 'refs/heads/main', baseRefNameHash: MAIN_HASH, headOid: hexToBase64(oid(n)), sourceRepoId: REPO })
    store.COLLAB!.transition!.push({ $id: 'thidden', $ownerId: MAINT, $createdAt: 9_000_000, repoId: REPO, targetId: PID(32), targetNumber: 32, targetKind: 1, kind: 11, delta: 1, asAuthor: 0 })
    const page = await queryPulls(sdk, repo, base, 32, 'devnet')
    // The proved totals count both; only the open hidden one comes off Open.
    expect(page.hidden).toBe(2)
    expect(page.counts).toEqual({ ...expected(30), closed: expected(30).closed + 1 })
  })

  it('assigns COLLAB nothing: the assignee filter is exact', async () => {
    const { sdk, repo } = fresh(30)
    expect((await queryPulls(sdk, repo, { ...base, state: 'all', assignee: COLLAB }, 30, 'devnet')).rows).toEqual([])
  })
})

describe('pullsLinking (an issue\'s backlinks, QW-015)', () => {
  it('finds the PRs whose description closes the issue, newest first, with their state', async () => {
    const { sdk, repo, store } = fresh(250, { churn: false })
    const patches = store['COLLAB']!['patch']!
    patches[4]!['body'] = 'Closes #1001, and more.'
    patches[39]!['body'] = 'Fixes: #1001'
    patches[199]!['body'] = 'See #1001 (a mention, not a close)'
    patches[209]!['body'] = 'fixes #10011'
    const got = await pullsLinking(sdk, repo, 1001, 'devnet')
    expect(got.pulls.map((p) => p.number)).toEqual([40, 5])
    // #40 was merged (every 10th): the backlink says so.
    expect(got.pulls[0]?.state.merged).toBe(true)
    expect(got.searched).toBeNull()
  })

  it('looks through a bounded number of chunks on a large repo, and says how many it searched', async () => {
    const { sdk, repo, store } = fresh(650, { churn: false })
    store['COLLAB']!['patch']![1]!['body'] = 'Fixes #1001'
    const got = await pullsLinking(sdk, repo, 1001, 'devnet')
    // #2 is among the oldest: past the chunks a backlink read looks through.
    expect(got.pulls).toEqual([])
    expect(got.searched).toBeGreaterThanOrEqual(300)
    expect(got.searched).toBeLessThan(650)
  })
})
