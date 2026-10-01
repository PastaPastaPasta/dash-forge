/**
 * QW2-009 / QW2-056: being assigned, asked to review, reviewing or being mentioned makes the inbox
 * follow a thread, and each thread says why it reaches me, for GitHub's reason filters.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it } from 'vitest'

import { idbGet, idbPut, resetMemoryStores } from '../idb'
import type { DocumentQuery } from '../sdk'
import {
  computeSubscriptions,
  DEFAULT_PREFS,
  feedQuery,
  followMentions,
  groupThreads,
  loadItems,
  matchesFilter,
  planFeeds,
  pollOnce,
  stateWhat,
  subsByThread,
  threadReasons,
  toItems,
  watchCounts,
  type Feed,
  type InboxItem,
  type Subscriptions,
  type ThreadSub,
} from './inbox'
import { listParticipation, MAX_PARTICIPATION, noteParticipation } from './participation'

const ME = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const OTHER = '7Ej2YTftCL23mVwvhviak8ZJMmpqcsVj7CU5KPxzyy4h'
const REPO_ID = '8H5JaQm8Z765UunuttoUuVsVMCmDoy2EBKgmGKYpdB2z'
const REPO = { id: REPO_ID, ownerId: OTHER, name: 'demo', private: false }
const ISSUE_ID = 'CR1u2SvFB97NvTF5zoqtYjjP4t2M5PyKEgFqPkKVThZP'
const PR_ID = 'Ad88NKGHimxUgGHrTGpBJjKpnzrQe8Zh4V5q13mRh85h'
const REVIEWED_ID = 'EJ6Nm8S4w2PnnqS4Zt1FDwMh4CjTKN2SkCgSvw4hLJWv'
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' }

const thread = (over: Partial<ThreadSub> = {}): ThreadSub => ({ id: ISSUE_ID, kind: 'issue', number: 1, title: 'Bug', repo: REPO, reason: 'assigned', since: 1000, ...over })

beforeEach(() => resetMemoryStores())

/** A chain of documents answering `==`, `in` and `>` / `>=` / `<=` where clauses. Every query is recorded. */
function chainSdk(docs: readonly Record<string, unknown>[]): EvoSDK & { queries: DocumentQuery[] } {
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
    // An RC1 forge-collab: no RC2 review indexes.
    contracts: { fetch: async () => ({ schemas: {} }) },
    documents: {
      query: async (q: DocumentQuery) => {
        queries.push(q)
        const rows = docs.filter((d) => d['type'] === q.documentTypeName && (q.where ?? []).every((w) => holds(d, w)))
        return new Map(rows.slice(0, q.limit ?? 100).map((d) => [String(d['$id']), d]))
      },
    },
  } as unknown as EvoSDK & { queries: DocumentQuery[] }
}

describe('stateWhat and reasons', () => {
  it('names an assignment of me by refId, even where a private repo sealed its value', () => {
    expect(stateWhat(6, undefined, ME, ME)).toBe('assigned you')
    expect(stateWhat(6, OTHER, ME, OTHER)).toBe('assigned someone')
    expect(stateWhat(13, undefined, ME, ME)).toBe('requested your review')
    // Another reviewer's request is not news to me.
    expect(stateWhat(13, undefined, ME, OTHER)).toBeNull()
  })

  it('marks an assignment, a review request and a mention as why an item reached me', () => {
    const state: Feed = { kind: 'state', type: 'event', repo: REPO, threads: [thread(), thread({ id: PR_ID, kind: 'pull', number: 2 })] }
    const items = toItems(state, [
      { $id: 'e1', $ownerId: OTHER, $createdAt: 2000, targetId: ISSUE_ID, kind: 6, value: ME, refId: ME },
      { $id: 'e2', $ownerId: OTHER, $createdAt: 2001, targetId: PR_ID, kind: 13, refId: ME },
      { $id: 'e3', $ownerId: OTHER, $createdAt: 2002, targetId: ISSUE_ID, kind: 4, value: 'bug' },
    ], ME)
    expect(items.map((i) => [i.what, i.reason])).toEqual([
      ['assigned you', 'assign'],
      ['requested your review', 'review_requested'],
      ['labelled bug', undefined],
    ])
    const comments: Feed = { kind: 'comments', thread: thread() }
    const said = toItems(comments, [
      { $id: 'c1', $ownerId: OTHER, $createdAt: 2000, body: 'cc @alice, can you look?' },
      { $id: 'c2', $ownerId: OTHER, $createdAt: 2001, body: 'no mention here' },
    ], ME, 'alice.dash')
    expect(said.map((i) => i.reason)).toEqual(['mention', undefined])
    const reviews = toItems({ kind: 'reviews', thread: thread({ kind: 'pull', reason: 'author' }) }, [{ $id: 'v1', $ownerId: OTHER, $createdAt: 2000, verdict: 3, body: '@alice can you check?' }], ME, 'alice.dash')
    expect(reviews[0]?.reason).toBe('mention')
    // A private repo's text is sealed: never read for a mention.
    const sealed = toItems({ kind: 'comments', thread: thread({ repo: { ...REPO, private: true } }) }, [{ $id: 'c3', $ownerId: OTHER, $createdAt: 2000, body: '@alice' }], ME, 'alice.dash')
    expect(sealed[0]?.reason).toBeUndefined()
  })
})

describe('computeSubscriptions (QW2-009)', () => {
  it('follows the threads I was assigned or asked to review, and those this browser saw me review', async () => {
    const sdk = chainSdk([
      { type: 'repo', $id: REPO_ID, $ownerId: OTHER, $createdAt: 1, name: 'demo' },
      { type: 'issue', $id: ISSUE_ID, $ownerId: OTHER, $createdAt: 100, repoId: REPO_ID, number: 1, title: 'Bug' },
      { type: 'patch', $id: PR_ID, $ownerId: OTHER, $createdAt: 200, repoId: REPO_ID, number: 2, title: 'Fix' },
      { type: 'patch', $id: REVIEWED_ID, $ownerId: OTHER, $createdAt: 300, repoId: REPO_ID, number: 3, title: 'Other fix' },
      // Assigned to #1 (then unassigned: still followed, as GitHub keeps the subscription), asked to review #2.
      { type: 'event', $id: 'a1', $ownerId: OTHER, $createdAt: 5000, targetId: ISSUE_ID, kind: 6, value: ME, refId: ME },
      { type: 'event', $id: 'a2', $ownerId: OTHER, $createdAt: 6000, targetId: ISSUE_ID, kind: 7, value: ME, refId: ME },
      { type: 'event', $id: 'r1', $ownerId: OTHER, $createdAt: 7000, targetId: PR_ID, kind: 13, refId: ME },
    ])
    await noteParticipation('devnet', ME, REVIEWED_ID, 'reviewed', 8000)
    const subs = await computeSubscriptions(sdk, 'devnet', FORGE, ME, DEFAULT_PREFS, 10_000)
    const byId = new Map(subs.threads.map((t) => [t.id, t]))
    expect(byId.get(ISSUE_ID)).toMatchObject({ reason: 'assigned', number: 1, since: 4999 })
    expect(byId.get(PR_ID)).toMatchObject({ reason: 'review-requested', kind: 'pull', since: 6999 })
    expect(byId.get(REVIEWED_ID)).toMatchObject({ reason: 'reviewed', kind: 'pull', since: 7999 })
    expect(subs.incomplete ?? []).toEqual([])
  })

  it('keeps the strongest reason, every reason, and the earliest start of any', async () => {
    const sdk = chainSdk([
      { type: 'repo', $id: REPO_ID, $ownerId: OTHER, $createdAt: 1, name: 'demo' },
      { type: 'issue', $id: ISSUE_ID, $ownerId: ME, $createdAt: 100, repoId: REPO_ID, number: 1, title: 'Mine' },
      { type: 'patch', $id: PR_ID, $ownerId: OTHER, $createdAt: 200, repoId: REPO_ID, number: 2, title: 'Fix' },
      { type: 'event', $id: 'a1', $ownerId: OTHER, $createdAt: 5000, targetId: ISSUE_ID, kind: 6, value: ME, refId: ME },
      // Asked to review #2 at 3000, commented on it at 4000: followed from the request.
      { type: 'event', $id: 'r1', $ownerId: OTHER, $createdAt: 3000, targetId: PR_ID, kind: 13, refId: ME },
      { type: 'comment', $id: 'c1', $ownerId: ME, $createdAt: 4000, repoId: REPO_ID, targetId: PR_ID },
    ])
    const subs = await computeSubscriptions(sdk, 'devnet', FORGE, ME, DEFAULT_PREFS, 10_000)
    const byId = new Map(subs.threads.map((t) => [t.id, t]))
    expect(byId.get(ISSUE_ID)).toMatchObject({ reason: 'author', reasons: ['author', 'assigned'], since: 100 })
    expect(byId.get(PR_ID)).toMatchObject({ reason: 'commented', reasons: ['commented', 'review-requested'], since: 2999 })
  })
})

describe('a review request from a PR author who is not a member (P1-1)', () => {
  // MAINTAINER owns the repo; OTHER opened #2 and is no member, so OTHER's request is an
  // `authorEvent`, not an `event`.
  const MAINTAINER = REVIEWED_ID
  const docs = [
    { type: 'repo', $id: REPO_ID, $ownerId: MAINTAINER, $createdAt: 1, name: 'demo' },
    { type: 'patch', $id: PR_ID, $ownerId: OTHER, $createdAt: 200, repoId: REPO_ID, number: 2, title: 'Fix' },
    { type: 'authorEvent', $id: 'ae1', $ownerId: OTHER, $createdAt: 7000, repoId: REPO_ID, targetId: PR_ID, kind: 13, refId: ME },
    // A request of another reviewer, and the author resolving a thread: not news to me.
    { type: 'authorEvent', $id: 'ae2', $ownerId: OTHER, $createdAt: 7001, repoId: REPO_ID, targetId: PR_ID, kind: 13, refId: MAINTAINER },
    { type: 'authorEvent', $id: 'ae3', $ownerId: OTHER, $createdAt: 7002, repoId: REPO_ID, targetId: PR_ID, kind: 11, refId: 'c1' },
  ]
  const isAddressee = (q: DocumentQuery): boolean => (q.where ?? []).some(([f, op, v]) => f === 'refId' && op === '==' && v === ME)

  it('follows the PR, with one more addressee read than before', async () => {
    const sdk = chainSdk(docs)
    const subs = await computeSubscriptions(sdk, 'devnet', FORGE, ME, DEFAULT_PREFS, 10_000)
    expect(subs.threads).toEqual([expect.objectContaining({ id: PR_ID, kind: 'pull', reason: 'review-requested', since: 6999, viaAuthor: true })])
    expect(subs.incomplete ?? []).toEqual([])
    // The member events' addressee index and the author events' one, once each, and no other
    // `authorEvent` read.
    expect(sdk.queries.filter(isAddressee).map((q) => q.documentTypeName).sort()).toEqual(['authorEvent', 'event'])
    expect(sdk.queries.filter((q) => q.documentTypeName === 'authorEvent')).toHaveLength(1)
  })

  /** `docs` plus an assignment of me (a member's `event`) and a comment of mine, with the addressee reads of `failing` types refused. */
  const withFailing = (failing: readonly string[]): ReturnType<typeof chainSdk> => {
    const sdk = chainSdk([
      ...docs,
      { type: 'issue', $id: ISSUE_ID, $ownerId: OTHER, $createdAt: 100, repoId: REPO_ID, number: 1, title: 'Bug' },
      { type: 'event', $id: 'a1', $ownerId: MAINTAINER, $createdAt: 5000, targetId: ISSUE_ID, kind: 6, value: ME, refId: ME },
      { type: 'patch', $id: REVIEWED_ID, $ownerId: OTHER, $createdAt: 300, repoId: REPO_ID, number: 3, title: 'Other fix' },
      { type: 'comment', $id: 'c1', $ownerId: ME, $createdAt: 4000, repoId: REPO_ID, targetId: REVIEWED_ID },
    ])
    const query = sdk.documents.query.bind(sdk.documents) as (q: DocumentQuery) => Promise<unknown>
    ;(sdk.documents as unknown as { query: (q: DocumentQuery) => Promise<unknown> }).query = async (q) => {
      if (failing.includes(q.documentTypeName) && isAddressee(q)) throw new Error('no such index')
      return query(q)
    }
    return sdk
  }
  const byId = (subs: Subscriptions): Map<string, ThreadSub> => new Map(subs.threads.map((t) => [t.id, t]))

  it('keeps the member events when the author events cannot be read, and says so', async () => {
    const subs = await computeSubscriptions(withFailing(['authorEvent']), 'devnet', FORGE, ME, DEFAULT_PREFS, 10_000)
    expect(byId(subs).get(ISSUE_ID)).toMatchObject({ reason: 'assigned' })
    expect(byId(subs).has(PR_ID)).toBe(false)
    expect(subs.incomplete).toEqual([expect.stringContaining('your assignments and review requests')])
  })

  it('keeps the author events when the member events cannot be read, and says so', async () => {
    const subs = await computeSubscriptions(withFailing(['event']), 'devnet', FORGE, ME, DEFAULT_PREFS, 10_000)
    expect(byId(subs).get(PR_ID)).toMatchObject({ reason: 'review-requested', viaAuthor: true })
    expect(byId(subs).has(ISSUE_ID)).toBe(false)
    expect(subs.incomplete).toEqual([expect.stringContaining('one of their two reads')])
  })

  it('with neither read, says so and keeps every other source', async () => {
    const subs = await computeSubscriptions(withFailing(['event', 'authorEvent']), 'devnet', FORGE, ME, DEFAULT_PREFS, 10_000)
    expect([...byId(subs).keys()]).toEqual([REVIEWED_ID])
    expect(byId(subs).get(REVIEWED_ID)).toMatchObject({ reason: 'commented' })
    expect(subs.incomplete).toEqual(['your assignments and review requests'])
  })

  it("ignores a 'review request' an issue's author wrote: only a PR has reviewers", async () => {
    const sdk = chainSdk([
      { type: 'repo', $id: REPO_ID, $ownerId: MAINTAINER, $createdAt: 1, name: 'demo' },
      { type: 'issue', $id: ISSUE_ID, $ownerId: OTHER, $createdAt: 100, repoId: REPO_ID, number: 1, title: 'Bug' },
      { type: 'authorEvent', $id: 'ae9', $ownerId: OTHER, $createdAt: 7000, repoId: REPO_ID, targetId: ISSUE_ID, kind: 13, refId: ME },
    ])
    const subs = await computeSubscriptions(sdk, 'devnet', FORGE, ME, DEFAULT_PREFS, 10_000)
    expect(subs.threads).toEqual([])
    const issue = thread({ reason: 'commented', viaAuthor: true })
    const feed: Feed = { kind: 'state', type: 'authorEvent', repo: REPO, threads: [issue] }
    expect(toItems(feed, [{ $id: 'ae9', $ownerId: OTHER, $createdAt: 7000, targetId: ISSUE_ID, kind: 13, refId: ME }], ME)).toEqual([])
  })

  it('reads the author events only of the PRs an author asked me to review', () => {
    const asked = thread({ id: PR_ID, kind: 'pull', number: 2, reason: 'commented', reasons: ['commented', 'review-requested'], viaAuthor: true })
    // Asked by a member (an `event`): the event feed already carries that request.
    const byMember = thread({ id: 'PR-BY-MEMBER', kind: 'pull', number: 4, reason: 'review-requested' })
    const other = thread({ id: REVIEWED_ID, kind: 'pull', number: 3, reason: 'author' })
    const elsewhere = thread({ id: ISSUE_ID, repo: { ...REPO, id: 'OTHER-REPO' }, reason: 'commented' })
    const subs: Subscriptions = { at: 1000, repos: [], threads: [asked, byMember, other, elsewhere], droppedRepos: 0, droppedThreads: 0 }
    const state = planFeeds(subs, DEFAULT_PREFS, ME).filter((f) => f.kind === 'state')
    expect(state.map((f) => (f.kind === 'state' ? [f.type, f.repo.id, f.threads.map((t) => t.id)] : null))).toEqual([
      ['event', REPO_ID, [PR_ID, 'PR-BY-MEMBER', REVIEWED_ID]],
      ['transition', REPO_ID, [PR_ID, 'PR-BY-MEMBER', REVIEWED_ID]],
      ['authorEvent', REPO_ID, [PR_ID]],
      ['event', 'OTHER-REPO', [ISSUE_ID]],
      ['transition', 'OTHER-REPO', [ISSUE_ID]],
    ])
    // The feed is the repo's `authorEvent` `feed` index, in forge-community.
    const f = state.find((x) => x.kind === 'state' && x.type === 'authorEvent')!
    expect(feedQuery(FORGE, f, { at: 5 })).toMatchObject({ dataContractId: 'COMMUNITY', documentTypeName: 'authorEvent', where: [['repoId', '==', REPO_ID], ['$createdAt', '>', 5]] })
  })

  it('notifies the reviewer asked, and only them', async () => {
    const sdk = chainSdk(docs)
    await pollOnce(sdk, 'devnet', FORGE, ME, { now: 10_000 })
    const items = await loadItems('devnet', ME)
    expect(items.map((i) => [i.id, i.what, i.reason, i.target?.number])).toEqual([['ae1', 'requested your review', 'review_requested', 2]])
  })
})

describe('participation record', () => {
  it('keeps the earliest time, and a review over a mention', async () => {
    await noteParticipation('devnet', ME, PR_ID, 'mentioned', 500)
    await noteParticipation('devnet', ME, PR_ID, 'reviewed', 900)
    await noteParticipation('devnet', ME, PR_ID, 'mentioned', 100)
    expect(await listParticipation('devnet', ME)).toEqual([{ targetId: PR_ID, reason: 'reviewed', at: 100 }])
    expect(await listParticipation('devnet', OTHER)).toEqual([])
  })

  it('stays bounded: past the cap the oldest go', async () => {
    for (let i = 0; i < MAX_PARTICIPATION + 3; i++) await noteParticipation('devnet', ME, `t${i}`, 'mentioned', 1000 + i)
    const kept = await listParticipation('devnet', ME)
    expect(kept).toHaveLength(MAX_PARTICIPATION)
    expect(kept.at(-1)?.targetId).toBe('t3')
  })

  it('a new issue that mentions me is followed from then on, at once (QW3-050)', async () => {
    const subs: Subscriptions = { at: 1000, repos: [{ repo: REPO, reason: 'watched' }], threads: [], droppedRepos: 0, droppedThreads: 0 }
    await idbPut('inbox', `devnet:${ME}:subs`, subs)
    const sdk = chainSdk([{ type: 'issue', $id: ISSUE_ID, $ownerId: OTHER, $createdAt: 1500, repoId: REPO_ID, number: 1, title: 'Help', body: 'What do you think, @alice?' }])
    await pollOnce(sdk, 'devnet', FORGE, ME, { now: 2000, name: 'alice.dash' })
    expect(await listParticipation('devnet', ME)).toEqual([{ targetId: ISSUE_ID, reason: 'mentioned', at: 1500 }])
    // The stored subscriptions follow it now (the watch summary and the Mentioned filter agree).
    const after = (await idbGet('inbox', `devnet:${ME}:subs`)) as Subscriptions
    expect(after.threads).toEqual([expect.objectContaining({ id: ISSUE_ID, kind: 'issue', number: 1, reason: 'mentioned', reasons: ['mentioned'], since: 1499 })])
    expect(watchCounts(after).seen).toBe(1)
  })
})

describe('watch summary (QW3-050)', () => {
  it('counts a thread under every reason it is followed for, not only its strongest', () => {
    const s: Subscriptions = {
      at: 0,
      repos: [{ repo: REPO, reason: 'watched' }],
      threads: [thread({ reason: 'assigned', reasons: ['assigned', 'mentioned'] }), thread({ id: 'old', reason: 'commented' })],
      droppedRepos: 0,
      droppedThreads: 0,
    }
    expect(watchCounts(s)).toEqual({ member: 0, watched: 1, starred: 0, joined: 1, addressed: 1, seen: 1 })
  })

  it('followMentions adds the reason to a thread already followed, keeping its earliest time', () => {
    const s: Subscriptions = { at: 0, repos: [], threads: [thread({ reason: 'assigned', since: 50 })], droppedRepos: 0, droppedThreads: 0 }
    const id = s.threads[0]!.id
    const out = followMentions(s, [{ id, kind: 'issue', repo: REPO, target: { kind: 'issue', number: 1, title: 'Bug' }, what: 'opened an issue', actor: OTHER, at: 400, read: false, reason: 'mention' }])
    expect(out.threads).toEqual([expect.objectContaining({ id, reason: 'assigned', reasons: ['assigned', 'mentioned'], since: 50 })])
  })
})

describe('reason filters (QW2-056)', () => {
  const item = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({ id, kind: 'comment', repo: REPO, target: { kind: 'issue', number: 1, title: 'Bug' }, what: 'commented', actor: OTHER, at: 1, read: false, ...over })
  const subs = (reason: ThreadSub['reason']): Subscriptions => ({ at: 0, repos: [], threads: [thread({ reason })], droppedRepos: 0, droppedThreads: 0 })

  it('files a thread under why I follow it and why each item reached me', () => {
    const [t] = groupThreads([item('a'), item('b', { reason: 'mention' })])
    const reasons = threadReasons(t!, subsByThread(subs('assigned')))
    expect([...reasons].sort()).toEqual(['assigned', 'mentioned'])
    expect(matchesFilter(reasons, 'assigned')).toBe(true)
    expect(matchesFilter(reasons, 'mentioned')).toBe(true)
    expect(matchesFilter(reasons, 'review-requested')).toBe(false)
    expect(matchesFilter(reasons, 'participating')).toBe(true)
  })

  it('files a thread I opened and was assigned under Assigned, even with no assignment item', () => {
    const [t] = groupThreads([item('a')])
    const sub: Subscriptions = { at: 0, repos: [], threads: [thread({ reason: 'author', reasons: ['author', 'assigned'] })], droppedRepos: 0, droppedThreads: 0 }
    expect(matchesFilter(threadReasons(t!, subsByThread(sub)), 'assigned')).toBe(true)
  })

  it('leaves a repo I only watch out of Participating', () => {
    const [t] = groupThreads([item('a', { kind: 'issue', what: 'opened an issue' })])
    const reasons = threadReasons(t!, subsByThread({ at: 0, repos: [{ repo: REPO, reason: 'watched' }], threads: [], droppedRepos: 0, droppedThreads: 0 }))
    expect(reasons.size).toBe(0)
    expect(matchesFilter(reasons, 'participating')).toBe(false)
  })
})
