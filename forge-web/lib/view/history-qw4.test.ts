/**
 * Imported history and timeline (QA wave 4): an issue's duplicates' back-references (QW4-024) and
 * a PR's source branch deleted / restored events (QW4-025), with their request budgets.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { ForgeIds } from '../deployments'
import { mockSdk, newSeen, type Doc } from '../repo/drive-mock'
import { invalidateRepoFeed } from '../repo/issues'
import type { RepoRef } from '../repo/contract'
import { DUPLICATE_SCAN_PAGES, readDuplicatesOf } from './issues-view'
import { sourceBranchEvents } from './head-updates'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const REPO = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const MAINT = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const IID = (n: number): string => base58Encode(sha256(new TextEncoder().encode(`dup${n}`)))
const repo: RepoRef = { forge: FORGE, repoId: REPO, ownerId: OWNER, name: 'demo', visibility: 'public' }

function store(closes: Doc[], issues = 5): Record<string, Record<string, Doc[]>> {
  const issue: Doc[] = []
  for (let i = 1; i <= issues; i++) issue.push({ $id: IID(i), $ownerId: OWNER, $createdAt: i, $updatedAt: i, repoId: REPO, number: i, title: `Issue ${i}` })
  return { COLLAB: { issue, transition: closes, patch: [] }, CORE: {} }
}
let t = 1000
const close = (n: number, extra: Doc = {}): Doc => ({ $id: `t${t}`, $ownerId: MAINT, $createdAt: t++, repoId: REPO, targetId: IID(n), targetNumber: n, targetKind: 0, kind: 1, delta: 1, asAuthor: 0, ...extra })

describe('duplicates of an issue (QW4-024)', () => {
  it('finds the issues closed as a duplicate of this one, from one read of the issue closes', async () => {
    const seen = newSeen()
    invalidateRepoFeed(repo)
    const sdk = mockSdk(store([close(2, { reason: 3, dupNumber: 1 }), close(3, { reason: 2 }), close(4, { reason: 3, dupNumber: 5 }), close(1, { reason: 3, dupNumber: 1 })]), seen)
    const dups = await readDuplicatesOf(sdk, repo, 1)
    expect(dups?.map((d) => [d.number, d.title, d.actor])).toEqual([[2, 'Issue 2', MAINT]])
    // Budget: the header's proved counts (shared), one page of closes, one read of the duplicate.
    expect(seen.queries.filter((q) => q.documentTypeName === 'transition')).toHaveLength(1)
    expect(seen.queries.filter((q) => q.documentTypeName === 'issue')).toHaveLength(1)
    expect(await readDuplicatesOf(sdk, repo, 3)).toEqual([])
  })

  it('reads nothing past the counts when the repo has more closes than it scans', async () => {
    const seen = newSeen()
    invalidateRepoFeed(repo)
    const closes = Array.from({ length: DUPLICATE_SCAN_PAGES * 100 + 1 }, (_, i) => close(i + 2))
    const sdk = mockSdk(store(closes, DUPLICATE_SCAN_PAGES * 100 + 3), seen)
    expect(await readDuplicatesOf(sdk, repo, 1)).toBeNull()
    expect(seen.queries.filter((q) => q.documentTypeName === 'transition')).toHaveLength(0)
  })
})

describe('source branch events (QW4-025)', () => {
  const HEAD = 'a'.repeat(40)
  const OTHER = 'b'.repeat(40)
  const ZERO = '0'.repeat(40)
  const u = (id: string, at: number, newOid: string, prevOid?: string) => ({ id, author: MAINT, createdAt: at, newOid, ...(prevOid ? { prevOid } : {}) })

  it('says when the branch was deleted from the head and restored at it, after the PR opened', () => {
    const ev = sourceBranchEvents([u('old', 1, ZERO, HEAD), u('push', 10, HEAD), u('del', 20, ZERO, HEAD), u('res', 30, HEAD), u('del2', 40, ZERO, HEAD)], 'refs/heads/feature-ff', HEAD, 5)
    expect(ev.map((e) => [e.id, e.kind, e.branch])).toEqual([
      ['del', 'deleted', 'feature-ff'],
      ['res', 'restored', 'feature-ff'],
      ['del2', 'deleted', 'feature-ff'],
    ])
  })

  it('ignores a delete of other commits and a new branch pushed under the name', () => {
    expect(sourceBranchEvents([u('del', 20, ZERO, OTHER)], 'refs/heads/f', HEAD, 0)).toEqual([])
    expect(sourceBranchEvents([u('del', 20, ZERO, HEAD), u('new', 30, OTHER), u('again', 40, HEAD)], 'refs/heads/f', HEAD, 0).map((e) => e.kind)).toEqual(['deleted'])
  })
})
