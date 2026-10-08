// @vitest-environment node
/**
 * The members-only share of a listed thread's comments (R8, qa5 Q5-D03): a public thread's row
 * says "3 comments (2 members-only)". It reads sealed comments only for a repo with members-only
 * content on, once per count, and counts specific-people letters as none of them.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { DocumentQuery } from '../sdk'
import type { RepoRef } from './contract'

const has = vi.hoisted(() => ({ value: true }))
vi.mock('./members-writes', async (orig) => ({
  ...(await orig<typeof import('./members-writes')>()),
  repoHasMembersKey: async () => has.value,
}))

import { membersOnlyCommentCounts } from './members-only-comments'
import { invalidateRepoFeed } from './issues'

const id = (name: string): string => base58Encode(sha256(new TextEncoder().encode(name)))
const REPO: RepoRef = { forge: { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }, repoId: id('repo'), ownerId: id('owner'), name: 'r', visibility: 'public' }
const A = id('thread-a')
const B = id('thread-b')
const C = id('thread-c')

const enc = (first: number): Uint8Array => Uint8Array.from([first, 1, 2, 3])
const comment = (n: number, target: string, sealed: 0x03 | 0x04 | null): Record<string, unknown> => ({
  $id: id(`c${n}`),
  $ownerId: id('who'),
  $createdAt: n,
  targetId: target,
  ...(sealed === null ? { body: 'hello' } : { enc: enc(sealed), epoch: 0 }),
})

/** An SDK answering every comment query with `docs`, recording the queries. */
function sdkWith(docs: () => Record<string, unknown>[], seen: DocumentQuery[]): EvoSDK {
  return {
    documents: {
      query: async (q: DocumentQuery) => {
        seen.push(q)
        return new Map(docs().map((d) => [String(d['$id']), d]))
      },
    },
  } as unknown as EvoSDK
}

beforeEach(() => {
  has.value = true
  invalidateRepoFeed(REPO)
})

describe('membersOnlyCommentCounts', () => {
  it('counts a thread\'s sealed comments, one read for the page: "3 comments (2 members-only)"', async () => {
    const seen: DocumentQuery[] = []
    const sdk = sdkWith(() => [comment(1, A, 0x03), comment(2, A, null), comment(3, A, 0x03), comment(4, B, null)], seen)
    const got = await membersOnlyCommentCounts(sdk, REPO, [
      { id: A, comments: 3 },
      { id: B, comments: 1 },
      { id: C, comments: 0 },
      { id: id('unknown'), comments: null },
    ])
    expect([...got]).toEqual([[A, 2]])
    expect(seen).toHaveLength(1)
    expect(seen[0]?.where).toEqual([['targetId', 'in', [A, B].sort()]])
  })

  it('counts a specific-people letter as no members-only comment', async () => {
    const seen: DocumentQuery[] = []
    const got = await membersOnlyCommentCounts(sdkWith(() => [comment(1, A, 0x04), comment(2, A, 0x03)], seen), REPO, [{ id: A, comments: 2 }])
    expect(got.get(A)).toBe(1)
  })

  it('reads nothing for a repo without members-only content, a private repo or a page with no comments', async () => {
    const seen: DocumentQuery[] = []
    const sdk = sdkWith(() => [comment(1, A, 0x03)], seen)
    has.value = false
    expect((await membersOnlyCommentCounts(sdk, REPO, [{ id: A, comments: 1 }])).size).toBe(0)
    has.value = true
    expect((await membersOnlyCommentCounts(sdk, { ...REPO, visibility: 'private' }, [{ id: A, comments: 1 }])).size).toBe(0)
    expect((await membersOnlyCommentCounts(sdk, REPO, [{ id: A, comments: 0 }, { id: B, comments: null }])).size).toBe(0)
    expect(seen).toHaveLength(0)
  })

  it('remembers a thread at its count, reads it again when it gained a comment, and after a write', async () => {
    const seen: DocumentQuery[] = []
    let docs = [comment(1, A, 0x03), comment(2, A, null)]
    const sdk = sdkWith(() => docs, seen)
    expect((await membersOnlyCommentCounts(sdk, REPO, [{ id: A, comments: 2 }])).get(A)).toBe(1)
    expect((await membersOnlyCommentCounts(sdk, REPO, [{ id: A, comments: 2 }])).get(A)).toBe(1)
    expect(seen).toHaveLength(1)
    docs = [...docs, comment(3, A, 0x03)]
    expect((await membersOnlyCommentCounts(sdk, REPO, [{ id: A, comments: 3 }])).get(A)).toBe(2)
    expect(seen).toHaveLength(2)
    invalidateRepoFeed(REPO)
    await membersOnlyCommentCounts(sdk, REPO, [{ id: A, comments: 3 }])
    expect(seen).toHaveLength(3)
  })

  it('reads none for more threads than one read can name', async () => {
    const seen: DocumentQuery[] = []
    const many = Array.from({ length: 101 }, (_, i) => ({ id: id(`m${i}`), comments: 1 }))
    expect((await membersOnlyCommentCounts(sdkWith(() => [], seen), REPO, many)).size).toBe(0)
    expect(seen).toHaveLength(0)
  })
})
