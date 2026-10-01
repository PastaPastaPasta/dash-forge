/**
 * RC2 S2/S3 in the inbox: the reviews on my PRs are one feed where forge-collab has
 * `review.toAuthor` (`patchId.$ownerId`, `$createdAt`), and the PRs I reviewed are followed on
 * every device where it has `review.author` (QW2-009). Without them, the per-thread reads stay.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it } from 'vitest'

import { idbGet, idbPut, resetMemoryStores } from '../idb'
import { resetContractShapes } from '../repo/contract-shape'
import type { DocumentQuery } from '../sdk'
import {
  computeSubscriptions,
  DEFAULT_PREFS,
  feedKey,
  feedQuery,
  loadItems,
  NO_REVIEW_INDEXES,
  planFeeds,
  pollOnce,
  reviewIndexes,
  toItems,
  withReviewedThreads,
  type Feed,
  type Subscriptions,
  type ThreadSub,
} from './inbox'

const ME = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const OTHER = '7Ej2YTftCL23mVwvhviak8ZJMmpqcsVj7CU5KPxzyy4h'
const REPO_ID = '8H5JaQm8Z765UunuttoUuVsVMCmDoy2EBKgmGKYpdB2z'
const REPO = { id: REPO_ID, ownerId: OTHER, name: 'demo', private: false }
const PR_ID = 'Ad88NKGHimxUgGHrTGpBJjKpnzrQe8Zh4V5q13mRh85h'
const OLD_PR_ID = 'EJ6Nm8S4w2PnnqS4Zt1FDwMh4CjTKN2SkCgSvw4hLJWv'
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' }

const myPr = (over: Partial<ThreadSub> = {}): ThreadSub => ({ id: PR_ID, kind: 'pull', number: 2, title: 'Fix', repo: REPO, reason: 'author', since: 200, ...over })
const subsWith = (threads: ThreadSub[], reviewIndexes?: Subscriptions['reviewIndexes']): Subscriptions => ({
  at: 1000,
  repos: [],
  threads,
  droppedRepos: 0,
  droppedThreads: 0,
  ...(reviewIndexes ? { reviewIndexes } : {}),
})

beforeEach(() => {
  resetMemoryStores()
  resetContractShapes()
})

/**
 * A chain of documents answering `==`, `in` and the range where clauses, with the registered
 * forge-collab's `review` indexes (`indexes`; null: the contract cannot be read). Every query is
 * recorded.
 */
function chainSdk(docs: readonly Record<string, unknown>[], indexes: readonly string[] | null = ['patch']): EvoSDK & { queries: DocumentQuery[] } {
  const holds = (d: Record<string, unknown>, [f, op, v]: readonly unknown[]): boolean => {
    const x = d[f as string]
    if (op === 'in') return (v as unknown[]).includes(x)
    if (op === '==') return x === v
    const n = v as number
    return op === '>' ? (x as number) > n : op === '>=' ? (x as number) >= n : op === '<' ? (x as number) < n : (x as number) <= n
  }
  const queries: DocumentQuery[] = []
  return {
    queries,
    contracts: {
      fetch: async (id: string) => {
        if (indexes === null) throw new Error('unreachable')
        return id === FORGE.collab ? { schemas: { review: { properties: {}, indices: indexes.map((name) => ({ name })) } } } : { schemas: {} }
      },
    },
    documents: {
      query: async (q: DocumentQuery) => {
        queries.push(q)
        const rows = docs.filter((d) => d['type'] === q.documentTypeName && (q.where ?? []).every((w) => holds(d, w)))
        return new Map(rows.slice(0, q.limit ?? 100).map((d) => [String(d['$id']), d]))
      },
    },
  } as unknown as EvoSDK & { queries: DocumentQuery[] }
}

const isReviewQuery = (q: DocumentQuery): boolean => q.documentTypeName === 'review'

describe('reviewIndexes', () => {
  it('reads S2 and S3 off the registered forge-collab', async () => {
    expect(await reviewIndexes(chainSdk([], ['patch', 'verdicts', 'toAuthor', 'author']), FORGE)).toEqual({ toAuthor: true, author: true })
    resetContractShapes()
    expect(await reviewIndexes(chainSdk([], ['patch', 'verdicts', 'author']), FORGE)).toEqual({ toAuthor: false, author: true })
  })

  it('says so when the contract cannot be read', async () => {
    expect(await reviewIndexes(chainSdk([], null), FORGE)).toBeNull()
  })
})

describe('planFeeds with S2', () => {
  const comment: ThreadSub = { ...myPr({ id: 'C', reason: 'commented' }) }

  it('reads the reviews on my PRs as one feed, past the thread cap', () => {
    const feeds = planFeeds(subsWith([myPr(), comment], { toAuthor: true, author: false }), DEFAULT_PREFS, ME)
    expect(feeds.map(feedKey)).not.toContain(`reviews:${PR_ID}`)
    const mine = feeds.find((f) => f.kind === 'myReviews')
    expect(mine).toMatchObject({ kind: 'myReviews', owner: ME })
    expect(mine && mine.kind === 'myReviews' ? mine.threads.map((t) => t.id) : []).toEqual([PR_ID, 'C'])
  })

  it('keeps one feed per PR I opened without S2 (or without my id)', () => {
    for (const feeds of [
      planFeeds(subsWith([myPr()], NO_REVIEW_INDEXES), DEFAULT_PREFS, ME),
      planFeeds(subsWith([myPr()]), DEFAULT_PREFS, ME),
      planFeeds(subsWith([myPr()], { toAuthor: true, author: true }), DEFAULT_PREFS),
    ]) {
      expect(feeds.map(feedKey)).toContain(`reviews:${PR_ID}`)
      expect(feeds.some((f) => f.kind === 'myReviews')).toBe(false)
    }
  })

  it('queries the derived property with ==, so a cursor can page it', () => {
    const f: Feed = { kind: 'myReviews', owner: ME, threads: [] }
    const q = feedQuery(FORGE, f, { at: 500, afterId: 'r9' })
    expect(q).toMatchObject({
      dataContractId: 'COLLAB',
      documentTypeName: 'review',
      where: [
        ['patchId.$ownerId', '==', ME],
        ['$createdAt', '>=', 500],
      ],
      orderBy: [['$createdAt', 'asc']],
      startAfter: 'r9',
    })
  })
})

describe('the S2 feed', () => {
  const review = (id: string, patchId: string, at: number, owner = OTHER): Record<string, unknown> => ({
    type: 'review',
    $id: id,
    $ownerId: owner,
    $createdAt: at,
    patchId,
    'patchId.$ownerId': ME,
    verdict: 1,
  })

  it('names the reviews on PRs it knows, never my own, and leaves the others to be resolved', () => {
    const f: Feed = { kind: 'myReviews', owner: ME, threads: [myPr()] }
    const items = toItems(f, [review('v1', PR_ID, 900), review('v2', OLD_PR_ID, 901), review('v3', PR_ID, 902, ME)] as never, ME)
    // On a PR I opened: filed under it even past the thread cap, where no subscription says so.
    expect(items.map((i) => [i.id, i.what, i.target?.number, i.reason])).toEqual([['v1', 'approved', 2, 'author']])
  })

  it('reads a PR past the thread cap, and its repo, only when a review names it', async () => {
    const sdk = chainSdk([
      { type: 'patch', $id: OLD_PR_ID, $ownerId: ME, $createdAt: 50, repoId: 'R2', number: 7, title: 'Old' },
      { type: 'repo', $id: 'R2', $ownerId: ME, $createdAt: 1, name: 'mine', visibility: 'public' },
    ])
    const f = { kind: 'myReviews', owner: ME, threads: [myPr()] } as const
    expect(await withReviewedThreads(sdk, FORGE, f, [review('v1', PR_ID, 900)] as never)).toBe(f)
    expect(sdk.queries).toHaveLength(0)
    const wider = await withReviewedThreads(sdk, FORGE, f, [review('v2', OLD_PR_ID, 901)] as never)
    expect(wider.threads.map((t) => [t.id, t.number, t.repo.name])).toEqual([
      [PR_ID, 2, 'demo'],
      [OLD_PR_ID, 7, 'mine'],
    ])
  })

  it('a poll stores the reviews on every PR I opened from one query, then pages on', async () => {
    await idbPut('inbox', `devnet:${ME}:subs`, subsWith([myPr()], { toAuthor: true, author: false }))
    const sdk = chainSdk([
      review('v1', PR_ID, 1500),
      review('v2', OLD_PR_ID, 1600),
      { type: 'patch', $id: OLD_PR_ID, $ownerId: ME, $createdAt: 50, repoId: REPO_ID, number: 7, title: 'Old' },
    ])
    const r = await pollOnce(sdk, 'devnet', FORGE, ME, { now: 2000 })
    expect(r.failed).toBe(0)
    expect(sdk.queries.filter(isReviewQuery)).toEqual([expect.objectContaining({ limit: 100 })])
    expect((await loadItems('devnet', ME)).map((i) => [i.id, i.target?.number]).sort()).toEqual([
      ['v1', 2],
      ['v2', 7],
    ])
    expect(await idbGet('inbox', `devnet:${ME}:cursor:myReviews`)).toEqual({ at: 1600 })
  })

  it('starts where the per-PR feeds an earlier build read had got to', async () => {
    await idbPut('inbox', `devnet:${ME}:subs`, subsWith([myPr()], { toAuthor: true, author: false }))
    await idbPut('inbox', `devnet:${ME}:cursor:reviews:${PR_ID}`, { at: 1550 })
    await idbPut('inbox', `devnet:${ME}:cursor:reviews:${OLD_PR_ID}`, { at: 1700 })
    const sdk = chainSdk([review('v1', PR_ID, 1500), review('v2', PR_ID, 1600)])
    await pollOnce(sdk, 'devnet', FORGE, ME, { now: 2000 })
    // v1 was within what #2's own feed read: not stored again (a pruned one stays gone).
    expect((await loadItems('devnet', ME)).map((i) => i.id)).toEqual(['v2'])
    // The old cursors stay until the S2 feed is past them all (1700), then go.
    expect(await idbGet('inbox', `devnet:${ME}:cursor:reviews:${PR_ID}`)).toEqual({ at: 1550 })
    const later = chainSdk([review('v1', PR_ID, 1500), review('v2', PR_ID, 1600), review('v3', PR_ID, 1800)])
    await pollOnce(later, 'devnet', FORGE, ME, { now: 3000 })
    expect((await loadItems('devnet', ME)).map((i) => i.id).sort()).toEqual(['v2', 'v3'])
    expect(await idbGet('inbox', `devnet:${ME}:cursor:reviews:${PR_ID}`)).toBeUndefined()
    expect(await idbGet('inbox', `devnet:${ME}:cursor:reviews:${OLD_PR_ID}`)).toBeUndefined()
  })
})

describe('the switch from per-PR review feeds', () => {
  const review = (id: string, at: number): Record<string, unknown> => ({ type: 'review', $id: id, $ownerId: OTHER, $createdAt: at, patchId: PR_ID, 'patchId.$ownerId': ME, verdict: 3 })

  it("counts an old cursor's last block as unread when it stopped inside it", async () => {
    await idbPut('inbox', `devnet:${ME}:subs`, subsWith([myPr()], { toAuthor: true, author: false }))
    // #2's feed read part of the reviews at 1500 (up to v1) and none after.
    await idbPut('inbox', `devnet:${ME}:cursor:reviews:${PR_ID}`, { at: 1500, afterId: 'v1' })
    await pollOnce(chainSdk([review('v0', 1400), review('v1', 1500), review('v2', 1500)]), 'devnet', FORGE, ME, { now: 2000 })
    // v0 was read; the block at 1500 is stored again rather than risk losing v2.
    expect((await loadItems('devnet', ME)).map((i) => i.id).sort()).toEqual(['v1', 'v2'])
    // The feed ended at 1500 on a short page (no afterId): past the old cursor's block, so it goes.
    expect(await idbGet('inbox', `devnet:${ME}:cursor:reviews:${PR_ID}`)).toBeUndefined()
  })
})

describe('computeSubscriptions with S3 (QW2-009)', () => {
  const docs = [
    { type: 'repo', $id: REPO_ID, $ownerId: OTHER, $createdAt: 1, name: 'demo' },
    { type: 'patch', $id: PR_ID, $ownerId: OTHER, $createdAt: 200, repoId: REPO_ID, number: 2, title: 'Fix' },
    // My review of #2, made on another device: this browser has no record of it.
    { type: 'review', $id: 'v1', $ownerId: ME, $createdAt: 3000, patchId: PR_ID, verdict: 1 },
  ]

  it('follows the PRs I reviewed on any device', async () => {
    const sdk = chainSdk(docs, ['patch', 'author'])
    const subs = await computeSubscriptions(sdk, 'devnet', FORGE, ME, DEFAULT_PREFS, 10_000)
    expect(subs.threads).toEqual([expect.objectContaining({ id: PR_ID, kind: 'pull', reason: 'reviewed', since: 2999 })])
    expect(subs.reviewIndexes).toEqual({ toAuthor: false, author: true })
    expect(subs.incomplete ?? []).toEqual([])
  })

  it('keeps the last known indexes when the contract cannot be read, and says so', async () => {
    const sdk = chainSdk(docs, null)
    const subs = await computeSubscriptions(sdk, 'devnet', FORGE, ME, DEFAULT_PREFS, 10_000, { toAuthor: true, author: true })
    expect(subs.reviewIndexes).toEqual({ toAuthor: true, author: true })
    expect(subs.threads).toEqual([expect.objectContaining({ id: PR_ID, reason: 'reviewed' })])
    expect(subs.incomplete).toEqual([expect.stringContaining('review indexes')])
  })

  it("recomputes subscriptions made against another deployment's forge-collab", async () => {
    await idbPut('inbox', `devnet:${ME}:subs`, { ...subsWith([], { toAuthor: true, author: true }), at: 9_000, collab: 'OLD-COLLAB' })
    const sdk = chainSdk(docs, ['patch'])
    const r = await pollOnce(sdk, 'devnet', FORGE, ME, { now: 10_000 })
    expect(r.subs).toMatchObject({ collab: 'COLLAB', reviewIndexes: NO_REVIEW_INDEXES })
  })

  it('without S3 reads no reviews by author (Drive would refuse), and keeps the browser record', async () => {
    const sdk = chainSdk(docs, ['patch'])
    const subs = await computeSubscriptions(sdk, 'devnet', FORGE, ME, DEFAULT_PREFS, 10_000)
    expect(sdk.queries.some(isReviewQuery)).toBe(false)
    expect(subs.threads).toEqual([])
    expect(subs.reviewIndexes).toEqual(NO_REVIEW_INDEXES)
  })
})
