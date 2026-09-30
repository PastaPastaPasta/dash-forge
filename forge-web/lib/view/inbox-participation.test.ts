/**
 * QW2-009 / QW2-056: being assigned, asked to review, reviewing or being mentioned makes the inbox
 * follow a thread, and each thread says why it reaches me, for GitHub's reason filters.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it } from 'vitest'

import { idbGet, idbPut, resetMemoryStores } from '../idb'
import type { DocumentQuery } from '../sdk'
import { computeSubscriptions, DEFAULT_PREFS, groupThreads, matchesFilter, pollOnce, stateWhat, threadReasons, toItems, type Feed, type InboxItem, type Subscriptions, type ThreadSub } from './inbox'
import { listParticipation, noteParticipation } from './participation'

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

/** A chain of documents answering `==`, `in` and `>` / `>=` / `<=` where clauses. */
function chainSdk(docs: readonly Record<string, unknown>[]): EvoSDK {
  const holds = (d: Record<string, unknown>, [f, op, v]: readonly unknown[]): boolean => {
    const x = d[f as string]
    if (op === 'in') return (v as unknown[]).includes(x)
    if (op === '==') return x === v
    const n = v as number
    return op === '>' ? (x as number) > n : op === '>=' ? (x as number) >= n : op === '<' ? (x as number) < n : (x as number) <= n
  }
  return {
    documents: {
      query: async (q: DocumentQuery) => {
        const rows = docs.filter((d) => d['type'] === q.documentTypeName && (q.where ?? []).every((w) => holds(d, w)))
        return new Map(rows.slice(0, q.limit ?? 100).map((d) => [String(d['$id']), d]))
      },
    },
  } as unknown as EvoSDK
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
    const state: Feed = { kind: 'state', type: 'event', repo: REPO, threads: [thread()] }
    const items = toItems(state, [
      { $id: 'e1', $ownerId: OTHER, $createdAt: 2000, targetId: ISSUE_ID, kind: 6, value: ME, refId: ME },
      { $id: 'e2', $ownerId: OTHER, $createdAt: 2001, targetId: ISSUE_ID, kind: 13, refId: ME },
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

  it('keeps the strongest reason: a thread I opened is mine, whoever else assigns me', async () => {
    const sdk = chainSdk([
      { type: 'repo', $id: REPO_ID, $ownerId: OTHER, $createdAt: 1, name: 'demo' },
      { type: 'issue', $id: ISSUE_ID, $ownerId: ME, $createdAt: 100, repoId: REPO_ID, number: 1, title: 'Mine' },
      { type: 'event', $id: 'a1', $ownerId: OTHER, $createdAt: 5000, targetId: ISSUE_ID, kind: 6, value: ME, refId: ME },
    ])
    const subs = await computeSubscriptions(sdk, 'devnet', FORGE, ME, DEFAULT_PREFS, 10_000)
    expect(subs.threads.filter((t) => t.id === ISSUE_ID).map((t) => t.reason)).toEqual(['author'])
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

  it('a new issue that mentions me is followed from then on (the next poll recomputes)', async () => {
    const subs: Subscriptions = { at: 1000, repos: [{ repo: REPO, reason: 'watched' }], threads: [], droppedRepos: 0, droppedThreads: 0 }
    await idbPut('inbox', `devnet:${ME}:subs`, subs)
    const sdk = chainSdk([{ type: 'issue', $id: ISSUE_ID, $ownerId: OTHER, $createdAt: 1500, repoId: REPO_ID, number: 1, title: 'Help', body: 'What do you think, @alice?' }])
    await pollOnce(sdk, 'devnet', FORGE, ME, { now: 2000, name: 'alice.dash' })
    expect(await listParticipation('devnet', ME)).toEqual([{ targetId: ISSUE_ID, reason: 'mentioned', at: 1500 }])
    expect(await idbGet('inbox', `devnet:${ME}:subs`)).toBeUndefined()
  })
})

describe('reason filters (QW2-056)', () => {
  const item = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({ id, kind: 'comment', repo: REPO, target: { kind: 'issue', number: 1, title: 'Bug' }, what: 'commented', actor: OTHER, at: 1, read: false, ...over })
  const subs = (reason: ThreadSub['reason']): Subscriptions => ({ at: 0, repos: [], threads: [thread({ reason })], droppedRepos: 0, droppedThreads: 0 })

  it('files a thread under why I follow it and why each item reached me', () => {
    const [t] = groupThreads([item('a'), item('b', { reason: 'mention' })])
    const reasons = threadReasons(t!, subs('assigned'))
    expect([...reasons].sort()).toEqual(['assigned', 'mentioned'])
    expect(matchesFilter(reasons, 'assigned')).toBe(true)
    expect(matchesFilter(reasons, 'mentioned')).toBe(true)
    expect(matchesFilter(reasons, 'review-requested')).toBe(false)
    expect(matchesFilter(reasons, 'participating')).toBe(true)
  })

  it('leaves a repo I only watch out of Participating', () => {
    const [t] = groupThreads([item('a', { kind: 'issue', what: 'opened an issue' })])
    const reasons = threadReasons(t!, { at: 0, repos: [{ repo: REPO, reason: 'watched' }], threads: [], droppedRepos: 0, droppedThreads: 0 })
    expect(reasons.size).toBe(0)
    expect(matchesFilter(reasons, 'participating')).toBe(false)
  })
})
