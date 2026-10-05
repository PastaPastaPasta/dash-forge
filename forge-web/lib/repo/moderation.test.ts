/**
 * Maintainer moderation (RC2 MOD): what a hide writes (the proof only where the contract has it),
 * and what readers collapse in a thread and in a list. The fold itself is the parity vectors'
 * (`hidden_items__*`, conformance.test.ts).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const writes: { documentType: string; data: Record<string, unknown> }[] = []
let proved = true

// Who a new document is for is read from its stored parents (members-writes.test.ts covers it);
// these fixtures write to public threads.
vi.mock('./members-writes', async (orig) => ({
  ...(await orig<typeof import('./members-writes')>()),
  targetAudience: async () => 'public',
  childAudience: async () => 'public',
  storedAudience: async () => ({ audience: 'public', doc: {} }),
}))
vi.mock('../sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sdk')>()
  return {
    ...real,
    createDocumentIdempotent: vi.fn(async (_sdk: unknown, _auth: unknown, p: { documentType: string; data: Record<string, unknown> }) => {
      writes.push({ documentType: p.documentType, data: p.data })
      return { documentId: '8rSFEyS7gidGdS4r8m22YtMEc519otpDNQ242Zw9c1Gb', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: null }
    }),
  }
})
vi.mock('./contract-shape', () => ({
  contractHasProperty: vi.fn(async (_sdk: unknown, _id: string, type: string, prop: string) => proved && type === 'event' && prop === 'asMaintainer'),
}))
vi.mock('./members', async (importOriginal) => {
  const real = await importOriginal<typeof import('./members')>()
  return { ...real, readMembershipsCached: vi.fn(async () => [{ identity: CAROL, role: 'maintainer', createdAt: 1 }]) }
})

import { decodeIdentifier } from '../auth/base58'
import { resetMemoryStores } from '../idb'
import type { Event } from '../rules'
import type { WriteAuth } from '../sdk'
import type { RepoRef } from './contract'
import { hideData, hiddenRowIds, hiddenThreadIds, setHidden, threadHidesOf, threadModeration } from './moderation'
import { moderationBlocked, moderationInput } from './moderation-fold'

const ALICE = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const BOB = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const CAROL = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const ISSUE = '8H5JaQm8Z765UunuttoUuVsVMCmDoy2EBKgmGKYpdB2z'
const COMMENT = 'EA8HsynH63cw1i8xQLoARwk43sDf74HrKut1D4RV3L35'
const REPO: RepoRef = {
  forge: { core: 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1', collab: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS', community: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS', group: '6dV3kMBWHGR7pLKrHToMBQgbTpjqeE2VAyCEWmLbrkWC' },
  repoId: 'DBL7NnqGZjyVHwo2jp3K1QD9oRBcbFZnSnB9kQ8bmoYu',
  ownerId: ALICE,
  name: 'demo',
  visibility: 'public',
}
const sdk = {} as EvoSDK
const auth = (identityId: string): WriteAuth => ({ identityId, network: 'devnet', getSigningKeyWif: () => 'x' })
const target = { id: ISSUE, number: 3 }
const hide = (id: string, actor: string, refId: string | null, createdAt: number, kind: 'hide' | 'unhide' = 'hide', value: string | null = null): Event => ({
  id,
  targetId: ISSUE,
  kind,
  actor,
  value,
  oid: null,
  ...(refId !== null ? { refId } : {}),
  createdAt,
})

beforeEach(() => {
  writes.length = 0
  proved = true
  resetMemoryStores()
})

describe('hide writes', () => {
  it('writes kind 24 with the item and reason, and the proof only where the contract has it', async () => {
    await setHidden(sdk, auth(CAROL), REPO, { target, item: COMMENT, reason: 'spam', hide: true })
    expect(writes[0]?.documentType).toBe('event')
    expect(writes[0]?.data).toMatchObject({ kind: 24, targetNumber: 3, value: 'spam', refId: decodeIdentifier(COMMENT), asMaintainer: decodeIdentifier(CAROL) })
    proved = false
    await setHidden(sdk, auth(CAROL), REPO, { target, item: null, reason: null, hide: true })
    expect(writes[1]?.data).toMatchObject({ kind: 24 })
    expect(writes[1]?.data).not.toHaveProperty('asMaintainer')
    expect(writes[1]?.data).not.toHaveProperty('refId')
    expect(writes[1]?.data).not.toHaveProperty('value')
  })

  it('an unhide is kind 25 and carries no reason', () => {
    const data = hideData(target, { item: COMMENT, reason: 'spam', hide: false, maintainer: CAROL })
    expect(data).toMatchObject({ kind: 25, refId: decodeIdentifier(COMMENT), asMaintainer: decodeIdentifier(CAROL) })
    expect(data).not.toHaveProperty('value')
  })
})

describe('what readers collapse', () => {
  it('folds a thread with its comments: a current maintainer counts without the proof, a writer never', () => {
    const events = [hide('e1', BOB, COMMENT, 10), hide('e2', CAROL, null, 11, 'hide', 'spam')]
    const m = threadModeration({ events, thread: { id: ISSUE, author: BOB }, owner: ALICE, members: [{ identity: CAROL, role: 'maintainer', createdAt: 1 }, { identity: BOB, role: 'writer', createdAt: 1 }], proved: false, comments: [{ id: COMMENT, author: BOB }] })
    expect(m.items).toEqual({})
    expect(m.thread).toMatchObject({ by: CAROL, reason: 'spam', via: 'item' })
  })

  it('keeps a list row only the thread-level hides, and judges them with the repo members', async () => {
    const events = [hide('e1', CAROL, COMMENT, 10), hide('e2', CAROL, null, 11)]
    expect(threadHidesOf(events).map((e) => e.id)).toEqual(['e2'])
    proved = false
    const rows = [
      { id: ISSUE, author: BOB, threadHides: threadHidesOf(events) },
      { id: COMMENT, author: BOB, threadHides: [] },
    ]
    expect([...(await hiddenThreadIds(sdk, REPO, 'devnet', rows)).keys()]).toEqual([ISSUE])
    expect([...(await hiddenThreadIds(sdk, REPO, 'devnet', [{ id: ISSUE, author: ALICE, threadHides: threadHidesOf(events) }])).keys()]).toEqual([])
  })
})

describe('a hide that would change nothing', () => {
  it('is blocked for the owner\'s content or decision, an inline comment hidden with its review, or no change', () => {
    const R1 = '6N175pfKBhzcNg9kdpPLBTG32LdpZCLxG6XPReg4NPHS'
    const OWNS = 'C6Gox4Qdg9iuQkAnq8hr6XSMYMKNUfSjESD81KrZu4pm'
    const events = [hide('e1', CAROL, R1, 10), hide('e2', ALICE, COMMENT, 11)]
    const m = moderationInput({
      events,
      thread: { id: ISSUE, author: BOB },
      owner: ALICE,
      members: [{ identity: CAROL, role: 'maintainer', createdAt: 1 }],
      proved: true,
      comments: [{ id: COMMENT, author: BOB }, { id: OWNS, author: ALICE }, { id: 'inline', author: BOB, reviewId: R1 }],
      reviews: [{ id: R1, reviewer: BOB }],
    })
    expect(moderationBlocked(m, CAROL, OWNS, true)).toBe('ownersContent')
    expect(moderationBlocked(m, ALICE, OWNS, true)).toBeNull()
    expect(moderationBlocked(m, CAROL, COMMENT, false)).toBe('ownerDecided')
    expect(moderationBlocked(m, CAROL, 'inline', false)).toBe('withItsReview')
    expect(moderationBlocked(m, CAROL, R1, true)).toBe('alreadyHidden')
    expect(moderationBlocked(m, CAROL, null, false)).toBe('notHidden')
    expect(moderationBlocked(m, CAROL, null, true)).toBeNull()
    expect(moderationBlocked(undefined, CAROL, null, true)).toBeNull()
  })

  it('a list assumes the proof until its read lands', () => {
    const rows = [{ id: ISSUE, author: BOB, threadHides: [hide('e1', 'stranger', null, 1)] }]
    expect([...hiddenRowIds(rows, ALICE, [], true).keys()]).toEqual([ISSUE])
    expect([...hiddenRowIds(rows, ALICE, [], false).keys()]).toEqual([])
  })

  it('says who hid a row and why, for its mark once revealed (QW4-038)', () => {
    const rows = [{ id: ISSUE, author: BOB, threadHides: [hide('e1', ALICE, null, 1, 'hide', 'spam')] }]
    expect(hiddenRowIds(rows, ALICE, [], false).get(ISSUE)).toMatchObject({ by: ALICE, reason: 'spam' })
  })
})
