/**
 * The local inbox, offline: feed planning and round-robin, cursors, item classification (never
 * my own actions), the jump-box parser, mentions and the assignment fold.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it } from 'vitest'

import { resetMemoryStores } from '../idb'
import type { DocumentQuery } from '../sdk'
import {
  BACKFILL_BUDGET,
  BACKFILL_MS,
  DEFAULT_PREFS,
  PAGE,
  advanceCursor,
  feedKey,
  feedQuery,
  initialCursor,
  itemsToDrop,
  loadItems,
  markRead,
  pickRound,
  planFeeds,
  pollOnce,
  stateWhat,
  toItems,
  type Feed,
  type InboxItem,
  type Subscriptions,
  type ThreadSub,
} from './inbox'
import { assignedTargets, mentions } from './mine'
import { parseJump } from './jump'
import { idbPut } from '../idb'

const ME = '5999iJiaZLMEb6KbjXYFDDYjwGWssatToUTJbXvXhxBp'
const OTHER = '8unje8KNimvQ15NJeNTM15m7Dc4o7QJs4ZstWrbXdGxv'
const REPO = { id: '8H5JaQm8Z765UunuttoUuVsVMCmDoy2EBKgmGKYpdB2z', ownerId: ME, name: 'demo', private: false }
const FORGE = { core: 'CORE', collab: 'COLLAB', group: 'GROUP' }

const thread = (over: Partial<ThreadSub> = {}): ThreadSub => ({
  id: 'CR1u2SvFB97NvTF5zoqtYjjP4t2M5PyKEgFqPkKVThZP',
  kind: 'pull',
  number: 7,
  title: 'Fix it',
  repo: REPO,
  reason: 'author',
  since: 1000,
  ...over,
})

const subs = (over: Partial<Subscriptions> = {}): Subscriptions => ({
  at: 0,
  repos: [{ repo: REPO, reason: 'owner' }],
  threads: [thread()],
  droppedRepos: 0,
  droppedThreads: 0,
  ...over,
})

describe('planFeeds', () => {
  it('reads threads, their repos state feed, and my repos new-item feeds', () => {
    const keys = planFeeds(subs(), DEFAULT_PREFS).map(feedKey)
    expect(keys).toEqual([
      `comments:${thread().id}`,
      `reviews:${thread().id}`,
      `state:event:${REPO.id}`,
      `state:authorEvent:${REPO.id}`,
      `new:issue:${REPO.id}`,
      `new:patch:${REPO.id}`,
    ])
  })
  it('reads reviews only on PRs I opened, stars and pushes only when opted in', () => {
    const starred = { repo: { ...REPO, id: 'S' }, reason: 'starred' as const }
    const s = subs({ repos: [{ repo: REPO, reason: 'owner' }, starred], threads: [thread({ reason: 'commented' }), thread({ id: 'I', kind: 'issue' })] })
    const off = planFeeds(s, DEFAULT_PREFS).map(feedKey)
    expect(off.filter((k) => k.startsWith('reviews:'))).toEqual([])
    expect(off.some((k) => k.endsWith(':S'))).toBe(false)
    expect(off.some((k) => k.startsWith('push:'))).toBe(false)
    const on = planFeeds(s, { stars: true, pushes: true }).map(feedKey)
    expect(on).toContain('new:issue:S')
    expect(on).toContain(`push:refUpdate:${REPO.id}`)
    expect(on).toContain('push:protectedRefUpdate:S')
  })
})

describe('pickRound', () => {
  it('takes everything when under budget', () => {
    expect(pickRound([1, 2, 3], 5, 4)).toEqual({ round: [1, 2, 3], next: 0 })
  })
  it('round-robins with wrap-around so every feed is read in turn', () => {
    const feeds = [0, 1, 2, 3, 4]
    const a = pickRound(feeds, 0, 2)
    const b = pickRound(feeds, a.next, 2)
    const c = pickRound(feeds, b.next, 2)
    expect([a.round, b.round, c.round]).toEqual([
      [0, 1],
      [2, 3],
      [4, 0],
    ])
  })
})

describe('cursors', () => {
  it('starts a thread feed where I joined, others a week before the feed was first watched', () => {
    const seen = 10 * BACKFILL_MS
    expect(initialCursor({ kind: 'comments', thread: thread({ since: seen - 5 }) }, seen)).toEqual({ at: seen - 5 })
    expect(initialCursor({ kind: 'comments', thread: thread({ since: 0 }) }, seen)).toEqual({ at: seen - BACKFILL_MS })
    expect(initialCursor({ kind: 'new', type: 'issue', repo: REPO }, seen)).toEqual({ at: seen - BACKFILL_MS })
  })
  it('moves to the last row on a short page, and keeps its id on a full one', () => {
    const row = (at: number, i = at) => ({ at, id: `id${i}` })
    expect(advanceCursor({ at: 5 }, [])).toEqual({ at: 5 })
    expect(advanceCursor({ at: 5 }, [row(6), row(9)])).toEqual({ at: 9 })
    const full = Array.from({ length: PAGE }, (_, i) => row(100 + i))
    expect(advanceCursor({ at: 5 }, full)).toEqual({ at: 100 + PAGE - 1, afterId: `id${100 + PAGE - 1}` })
    // A full page from one busy block: continue inside the block, after its last id.
    const block = Array.from({ length: PAGE }, (_, i) => row(50, i))
    expect(advanceCursor({ at: 5 }, block)).toEqual({ at: 50, afterId: `id${PAGE - 1}` })
  })
  it('queries past the cursor on the right index', () => {
    const q = feedQuery(FORGE, { kind: 'comments', thread: thread() }, { at: 42 })
    expect(q).toMatchObject({ dataContractId: 'COLLAB', documentTypeName: 'comment', orderBy: [['$createdAt', 'asc']], limit: PAGE })
    expect(q.where).toEqual([['targetId', '==', thread().id], ['$createdAt', '>', 42]])
    expect(q.startAfter).toBeUndefined()
    const inBlock = feedQuery(FORGE, { kind: 'comments', thread: thread() }, { at: 42, afterId: 'X' })
    expect(inBlock.where?.[1]).toEqual(['$createdAt', '>=', 42])
    expect(inBlock.startAfter).toBe('X')
    expect(feedQuery(FORGE, { kind: 'push', type: 'refUpdate', repo: REPO }, { at: 1 }).dataContractId).toBe('CORE')
    expect(feedQuery(FORGE, { kind: 'reviews', thread: thread() }, { at: 1 }).where?.[0]).toEqual(['patchId', '==', thread().id])
  })
})

describe('toItems', () => {
  const doc = (owner: string, at: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ $id: `d${at}`, $ownerId: owner, $createdAt: at, ...extra })

  it('never notifies me of my own actions', () => {
    const f: Feed = { kind: 'comments', thread: thread() }
    expect(toItems(f, [doc(ME, 2000, { targetId: thread().id })], ME)).toEqual([])
    expect(toItems(f, [doc(OTHER, 2000, { targetId: thread().id })], ME)).toHaveLength(1)
  })
  it('turns new issues and PRs in my repos into items with their number and title', () => {
    const f: Feed = { kind: 'new', type: 'patch', repo: REPO }
    const [item] = toItems(f, [doc(OTHER, 5, { repoId: REPO.id, number: 3, title: 'Add X' })], ME)
    expect(item).toMatchObject({ kind: 'pull', what: 'opened a pull request', target: { kind: 'pull', number: 3, title: 'Add X' }, actor: OTHER, read: false })
  })
  it('reports state changes only on my threads, after I joined', () => {
    const t = thread({ since: 100 })
    const f: Feed = { kind: 'state', type: 'event', repo: REPO, threads: [t] }
    const items = toItems(
      f,
      [
        doc(OTHER, 50, { targetId: t.id, kind: 1 }),
        doc(OTHER, 150, { targetId: t.id, kind: 3 }),
        doc(OTHER, 160, { targetId: 'someone-elses-thread', kind: 1 }),
        doc(OTHER, 170, { targetId: t.id, kind: 4, value: 'bug' }),
        doc(ME, 180, { targetId: t.id, kind: 2 }),
      ],
      ME,
    )
    expect(items.map((i) => i.what)).toEqual(['marked merged', 'labelled bug'])
  })
  it('in a private repo, never shows an event value: the feed has no keys to open or check it (L4)', () => {
    const repo = { ...REPO, private: true }
    const t = thread({ since: 0, repo })
    const f: Feed = { kind: 'state', type: 'event', repo, threads: [t] }
    const items = toItems(f, [doc(OTHER, 170, { targetId: t.id, kind: 4, value: 'planted' }), doc(OTHER, 171, { targetId: t.id, kind: 6, value: ME })], ME)
    expect(items.map((i) => i.what)).toEqual(['labelled', 'assigned someone'])
  })
  it('names review verdicts and pushes', () => {
    const reviews = toItems({ kind: 'reviews', thread: thread() }, [doc(OTHER, 5, { verdict: 1 }), doc(OTHER, 6, { verdict: 2 })], ME)
    expect(reviews.map((i) => i.what)).toEqual(['approved', 'requested changes'])
    const push = toItems({ kind: 'push', type: 'refUpdate', repo: REPO }, [doc(OTHER, 5, { refName: 'refs/heads/main' })], ME)
    expect(push[0]?.what).toBe('pushed to main')
  })
  it('drops documents that do not parse instead of casting them', () => {
    expect(toItems({ kind: 'new', type: 'issue', repo: REPO }, [{ $id: 'x', $ownerId: OTHER }], ME)).toEqual([])
  })
})

describe('stateWhat', () => {
  it('says who was assigned', () => {
    expect(stateWhat(6, ME, ME)).toBe('assigned you')
    expect(stateWhat(6, OTHER, ME)).toBe('assigned someone')
    expect(stateWhat(99, undefined, ME)).toBeNull()
  })
})

describe('assigned in a private repo (L4)', () => {
  it('ignores event values the scan cannot open or check', () => {
    const ev = { $id: 'a', targetId: 't', kind: 6, value: ME, $createdAt: 1 }
    expect([...assignedTargets([ev], ME)]).toEqual(['t'])
    expect([...assignedTargets([ev], ME, true)]).toEqual([])
  })
})

describe('inbox state', () => {
  beforeEach(() => resetMemoryStores())
  const item = (id: string, at: number, read = false): InboxItem => ({ id, kind: 'comment', repo: REPO, what: 'commented', actor: OTHER, at, read })

  it('marks one, then all, read; per identity', async () => {
    for (const it of [item('a', 1), item('b', 2)]) await idbPut('inbox', `devnet:${ME}:item:${it.id}`, it)
    await idbPut('inbox', `devnet:${OTHER}:item:z`, item('z', 3))
    await markRead('devnet', ME, ['a'])
    expect((await loadItems('devnet', ME)).map((i) => [i.id, i.read])).toEqual([
      ['b', false],
      ['a', true],
    ])
    await markRead('devnet', ME)
    expect((await loadItems('devnet', ME)).every((i) => i.read)).toBe(true)
    expect((await loadItems('devnet', OTHER))[0]?.read).toBe(false)
  })
  it('drops the oldest read items first when over the cap', () => {
    expect(itemsToDrop([item('new', 3), item('oldRead', 1, true), item('oldUnread', 0)], 2)).toEqual(['oldRead'])
    expect(itemsToDrop([item('a', 1)], 2)).toEqual([])
  })
})

describe('mentions and assignments (bounded scans)', () => {
  it('finds @name and the identity id, not look-alikes', () => {
    expect(mentions('ping @alice please', ME, 'alice.dash')).toBe(true)
    expect(mentions('@Alice: see this', ME, 'alice.dash')).toBe(true)
    expect(mentions('mail me at x@alice.dash', ME, 'alice.dash')).toBe(false)
    expect(mentions('@alicedev here', ME, 'alice.dash')).toBe(false)
    expect(mentions(`cc ${ME}`, ME, null)).toBe(true)
    expect(mentions(undefined, ME, 'alice')).toBe(false)
  })
  it('folds assign and unassign in ($createdAt, $id) order', () => {
    const ev = (targetId: string, kind: number, value: string, at: number, id = `e${at}`) => ({ $id: id, targetId, kind, value, $createdAt: at })
    const got = assignedTargets([ev('t1', 6, ME, 1), ev('t2', 6, ME, 2), ev('t2', 7, ME, 3), ev('t3', 6, OTHER, 4), ev('t1', 7, OTHER, 5)], ME)
    expect([...got]).toEqual(['t1'])
    // Same block: ($createdAt, $id) decides, whatever the input order.
    expect([...assignedTargets([ev('t4', 7, ME, 9, 'B'), ev('t4', 6, ME, 9, 'A')], ME)]).toEqual([])
    expect([...assignedTargets([ev('t4', 6, ME, 9, 'B'), ev('t4', 7, ME, 9, 'A')], ME)]).toEqual(['t4'])
  })
})

describe('parseJump', () => {
  it('reads owner/name, owner/name#n, @name and #n', () => {
    expect(parseJump('alice/project', false)).toEqual({ kind: 'repo', owner: 'alice', name: 'project' })
    expect(parseJump('@alice/project#12', false)).toEqual({ kind: 'repo', owner: 'alice', name: 'project', number: 12 })
    expect(parseJump('@alice', false)).toEqual({ kind: 'profile', name: 'alice' })
    expect(parseJump(ME, false)).toEqual({ kind: 'profile', name: ME })
    expect(parseJump(' #42 ', true)).toEqual({ kind: 'number', number: 42 })
    expect(parseJump('', true)).toBeNull()
  })
  it('explains #n outside a repo and junk', () => {
    expect(parseJump('#3', false)).toMatchObject({ kind: 'invalid' })
    expect(parseJump('a b', false)).toMatchObject({ kind: 'invalid' })
    expect(parseJump('a/b/c', false)).toMatchObject({ kind: 'invalid' })
  })
})

describe('a thread watched after its state events landed (L-17)', () => {
  beforeEach(() => resetMemoryStores())
  const ISSUE = thread({ id: 'ISSUE1', kind: 'issue', number: 1, title: 'First', since: 100 })
  const PR = thread({ id: 'PR2', kind: 'pull', number: 2, title: 'Greet by name', since: 300 })
  const MERGED = { $id: 'EV-MERGE', $ownerId: OTHER, $createdAt: 500, repoId: REPO.id, targetId: PR.id, kind: 3 }

  /** An SDK over `docs` answering `==`, ranges, `$createdAt` order and `limit` as Drive does; logs every query. */
  function chainSdk(docs: readonly Record<string, unknown>[]): { sdk: EvoSDK; queries: DocumentQuery[] } {
    const queries: DocumentQuery[] = []
    const holds = (d: Record<string, unknown>, [f, op, v]: readonly unknown[]): boolean => {
      const x = d[f as string] as number
      const n = v as number
      return op === '==' ? d[f as string] === v : op === '>' ? x > n : op === '>=' ? x >= n : op === '<' ? x < n : x <= n
    }
    const sdk = {
      documents: {
        query: async (q: DocumentQuery) => {
          queries.push(q)
          const desc = q.orderBy?.[0]?.[1] === 'desc'
          const rows = docs
            .filter((d) => d['type'] === q.documentTypeName && (q.where ?? []).every((w) => holds(d, w)))
            .sort((a, b) => ((a['$createdAt'] as number) - (b['$createdAt'] as number)) * (desc ? -1 : 1))
          return new Map(rows.slice(0, q.limit ?? 100).map((d) => [String(d['$id']), d]))
        },
      },
    } as unknown as EvoSDK
    return { sdk, queries }
  }
  const watch = (threads: ThreadSub[], at: number): Promise<void> => idbPut('inbox', `devnet:${ME}:subs`, subs({ at, repos: [], threads }))
  const backfills = (qs: readonly DocumentQuery[]): DocumentQuery[] => qs.filter((q) => q.where?.[0]?.[0] === 'targetId' && q.documentTypeName !== 'comment' && q.documentTypeName !== 'review')
  const stateReads = (qs: readonly DocumentQuery[]): DocumentQuery[] => qs.filter((q) => q.documentTypeName === 'event' || q.documentTypeName === 'authorEvent')

  it('shows "marked merged" once the PR is watched, for one more query, once', async () => {
    const { sdk, queries } = chainSdk([{ ...MERGED, type: 'event' }])
    // Poll 1: only the issue is watched; the repo's state feed reads the merge (on a PR not
    // watched yet) and moves past it.
    await watch([ISSUE], 1000)
    await pollOnce(sdk, 'devnet', FORGE, ME, { now: 1000 })
    expect(await loadItems('devnet', ME)).toEqual([])

    // Poll 2: the PR is watched now (the subscriptions were recomputed).
    await watch([PR, ISSUE], 2000)
    queries.length = 0
    await pollOnce(sdk, 'devnet', FORGE, ME, { now: 2000 })
    expect((await loadItems('devnet', ME)).map((i) => [i.target?.number, i.what])).toEqual([[2, 'marked merged']])
    // The budget: the two state feeds, plus ONE backfill (the authorEvent feed read nothing past
    // the PR's start, so it needs none), on the PR's own `target` index, bounded by the cursor.
    expect(backfills(queries)).toEqual([
      {
        dataContractId: 'COLLAB',
        documentTypeName: 'event',
        where: [['targetId', '==', PR.id], ['$createdAt', '>', 300], ['$createdAt', '<=', 500]],
        orderBy: [['$createdAt', 'desc']],
        limit: PAGE,
      },
    ])
    expect(stateReads(queries)).toHaveLength(3)

    // Poll 3: nothing is backfilled twice.
    queries.length = 0
    await pollOnce(sdk, 'devnet', FORGE, ME, { now: 3000 })
    expect(stateReads(queries)).toHaveLength(2)
    expect((await loadItems('devnet', ME)).map((i) => i.id)).toEqual(['EV-MERGE'])
  })

  it('needs no backfill when the feed has not read past the thread yet', async () => {
    const docs: Record<string, unknown>[] = []
    const { sdk, queries } = chainSdk(docs)
    await watch([ISSUE], 1000)
    await pollOnce(sdk, 'devnet', FORGE, ME, { now: 1000 })
    // The merge lands after that poll: the feed's next read, with the PR watched, sees it.
    docs.push({ ...MERGED, type: 'event', $createdAt: 5000 })
    await watch([PR, ISSUE], 2000)
    queries.length = 0
    await pollOnce(sdk, 'devnet', FORGE, ME, { now: 2000 })
    expect(backfills(queries)).toEqual([])
    expect((await loadItems('devnet', ME)).map((i) => i.what)).toEqual(['marked merged'])
  })

  it('spreads many backfills over polls, BACKFILL_BUDGET at a time, and each runs once', async () => {
    const many = Array.from({ length: BACKFILL_BUDGET + 2 }, (_, i) => thread({ id: `T${i}`, kind: 'issue', number: 10 + i, since: 300 }))
    const { sdk, queries } = chainSdk([{ ...MERGED, type: 'event', targetId: 'T0' }])
    await watch([ISSUE], 1000)
    await pollOnce(sdk, 'devnet', FORGE, ME, { now: 1000 })
    await watch([...many, ISSUE], 2000)
    const counts: number[] = []
    for (const now of [2000, 3000, 4000]) {
      queries.length = 0
      await pollOnce(sdk, 'devnet', FORGE, ME, { now })
      counts.push(backfills(queries).length)
    }
    expect(counts).toEqual([BACKFILL_BUDGET, 2, 0])
    expect((await loadItems('devnet', ME)).map((i) => i.target?.number)).toEqual([10])
  })
})
