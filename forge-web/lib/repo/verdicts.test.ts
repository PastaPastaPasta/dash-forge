/**
 * The merge box's proved verdict count (RC1 R-16) against the Drive-shaped mock (`./drive-mock`):
 * a PR view reads it in exactly one grouped count on the `verdicts` index, beside the thread's
 * one composite, and it counts member verdicts (1/2) on the current head only.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { ForgeIds } from '../deployments'
import { bytesToBase64, hexToBase64 } from '../sdk'
import { REVIEW_LIST_PAGES, loadPullThread } from '../view/issues-view'
import type { RepoRef } from './contract'
import { mockSdk, newSeen, type Doc, type Store } from './drive-mock'
import { invalidateMembers } from './members'
import { memberVerdictQuery, readMemberVerdictDocs, readProvedVerdicts, verdictsQuery } from './verdicts'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' }
const REPO = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const MAINT = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const WRITER = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const AUTHOR = '7Ej2YTftCL23mVwvhviak8ZJMmpqcsVj7CU5KPxzyy4h'
const STRANGER = 'BTJPjCLCnRaJQkqakpcdLYFsaHgFf5XSEBNxFCyYBteH'
const PATCH = base58Encode(sha256(new TextEncoder().encode('patch1')))
const HEAD = 'ab'.repeat(20)
const OLD = 'cd'.repeat(20)
const REPO_REF: RepoRef = { forge: FORGE, repoId: REPO, ownerId: OWNER, name: 'demo', visibility: 'public' }

let t = 1_000
const review = (who: string, verdict: number, commit: string, extra: Doc = {}): Doc => ({
  $id: `r${t}`,
  $ownerId: who,
  $createdAt: t++,
  repoId: REPO,
  patchId: PATCH,
  verdict,
  commitOid: hexToBase64(commit),
  vis: 'public',
  ...(verdict === 1 || verdict === 2 ? { asMember: who } : {}),
  ...extra,
})

/**
 * One open PR on HEAD: the maintainer approved twice (a re-approval), the writer requested
 * changes, a stranger approved as a non-member (4), and an approval sits on an older head.
 */
function store(): Store {
  return {
    COLLAB: {
      patch: [
        {
          $id: PATCH,
          $ownerId: AUTHOR,
          $createdAt: 500,
          repoId: REPO,
          number: 1,
          title: 'A change',
          body: '',
          baseRefName: 'refs/heads/main',
          baseRefNameHash: bytesToBase64(sha256(new TextEncoder().encode('refs/heads/main'))),
          headOid: hexToBase64(HEAD),
          sourceRepoId: REPO,
          vis: 'public',
        },
      ],
      review: [review(MAINT, 1, OLD), review(MAINT, 1, HEAD), review(MAINT, 1, HEAD), review(WRITER, 2, HEAD), review(STRANGER, 4, HEAD)],
    },
    CORE: {
      maintainer: [
        { $id: 'm1', $ownerId: OWNER, $createdAt: 1, repoId: REPO, memberId: OWNER },
        { $id: 'm2', $ownerId: OWNER, $createdAt: 2, repoId: REPO, memberId: MAINT },
      ],
      writer: [{ $id: 'w1', $ownerId: OWNER, $createdAt: 3, repoId: REPO, memberId: WRITER }],
    },
  }
}

describe('proved verdict count (RC1 R-16)', () => {
  it('asks the verdicts index for member verdicts on one head, grouped by verdict', () => {
    expect(verdictsQuery(REPO_REF, PATCH, HEAD)).toEqual({
      dataContractId: 'COLLAB',
      documentTypeName: 'review',
      where: [
        ['patchId', '==', PATCH],
        ['commitOid', '==', hexToBase64(HEAD)],
        ['verdict', 'in', [1, 2]],
      ],
      orderBy: [['verdict', 'asc']],
      groupBy: ['verdict'],
    })
  })

  it('counts member approvals and change requests on the head only (an upper bound)', async () => {
    const seen = newSeen()
    const proved = await readProvedVerdicts(mockSdk(store(), seen), REPO_REF, PATCH, HEAD.toUpperCase())
    // The re-approval counts twice; the older head's approval and the stranger's 4 do not.
    expect(proved).toEqual({ headOid: HEAD, approvals: 2, changesRequested: 1 })
    expect(seen.counts).toHaveLength(1)
  })

  it('reads nothing for a PR with no head a review could name', async () => {
    const seen = newSeen()
    expect(await readProvedVerdicts(mockSdk(store(), seen), REPO_REF, PATCH, '')).toBeNull()
    expect(await readProvedVerdicts(mockSdk(store(), seen), REPO_REF, PATCH, 'abc')).toBeNull()
    expect(seen.counts).toHaveLength(0)
  })

  it('costs a PR view one composite and one grouped count, beside the fold it never replaces', async () => {
    invalidateMembers(REPO_REF)
    const seen = newSeen()
    const thread = await loadPullThread(mockSdk(store(), seen), REPO_REF, 1)
    expect(seen.composites).toHaveLength(1)
    // The verdict count is the view's only count or sum.
    expect(seen.counts).toEqual([verdictsQuery(REPO_REF, PATCH, HEAD)])
    expect(seen.sums).toHaveLength(0)
    // The plain reads are the DPNS names and the base ref's history (the repo chrome's, in the app).
    // Never the repo's bans: the page applies them when they land, so nothing on it waits on them.
    expect(seen.queries.map((q) => q.documentTypeName).sort()).toEqual(['config', 'domain', 'protectedRefUpdate', 'refUpdate'])
    expect(thread?.verdicts).toEqual({ headOid: HEAD, approvals: 2, changesRequested: 1 })
    // The fold, which gates the merge, counts each reviewer once.
    expect(thread?.approvals?.approvers).toEqual([MAINT])
    expect(thread?.approvals?.changesRequested).toEqual([WRITER])
  })

  it('shows the thread without the count when the count cannot be read', async () => {
    invalidateMembers(REPO_REF)
    const sdk = mockSdk(store(), newSeen())
    ;(sdk as unknown as { documents: { count: () => Promise<never> } }).documents.count = () => Promise.reject(new Error('down'))
    const thread = await loadPullThread(sdk, REPO_REF, 1)
    expect(thread?.verdicts).toBeNull()
    expect(thread?.approvals?.approvers).toEqual([MAINT])
  })
})

/** `store()` with `n` non-member approvals (4) on the head, all older than its member reviews. */
function flooded(n: number): Store {
  const strangers = Array.from({ length: n }, () => review(STRANGER, 4, HEAD))
  const s = store()
  s['COLLAB']!['review'] = [...strangers, ...s['COLLAB']!['review']!]
  return s
}

describe('member verdicts: the approvals a review flood cannot reach', () => {
  it('reads each member verdict on the verdicts index with every field pinned', () => {
    expect(memberVerdictQuery(REPO_REF, PATCH, HEAD, 2)).toEqual({
      dataContractId: 'COLLAB',
      documentTypeName: 'review',
      where: [
        ['patchId', '==', PATCH],
        ['commitOid', '==', hexToBase64(HEAD)],
        ['verdict', '==', 2],
      ],
      orderBy: [
        ['patchId', 'asc'],
        ['commitOid', 'asc'],
        ['verdict', 'asc'],
      ],
    })
  })

  it('reads the member approvals and change requests on the head, nothing else', async () => {
    const seen = newSeen()
    const docs = await readMemberVerdictDocs(mockSdk(flooded(150), seen), REPO_REF, PATCH, HEAD.toUpperCase())
    expect(docs.map((d) => [d['$ownerId'], d['verdict']])).toEqual([
      [MAINT, 1],
      [MAINT, 1],
      [WRITER, 2],
    ])
    expect(seen.queries).toEqual([memberVerdictQuery(REPO_REF, PATCH, HEAD, 1), memberVerdictQuery(REPO_REF, PATCH, HEAD, 2)].map((q) => ({ ...q, limit: 100 })))
    expect(await readMemberVerdictDocs(mockSdk(store(), newSeen()), REPO_REF, PATCH, 'abc')).toEqual([])
  })

  it('keeps a flooded PR\'s approvals, and says its review list is cut short', async () => {
    invalidateMembers(REPO_REF)
    const thread = await loadPullThread(mockSdk(flooded(100 * REVIEW_LIST_PAGES), newSeen()), REPO_REF, 1)
    expect(thread?.reviewsIncomplete).toBe(true)
    expect(thread?.approvals?.approvers).toEqual([MAINT])
    expect(thread?.approvals?.changesRequested).toEqual([WRITER])
    // The list: the composite's first page, and every member verdict on the head.
    const members = thread?.reviews.filter((r) => r.reviewer !== STRANGER).map((r) => [r.reviewer, r.verdictCode])
    expect(members).toEqual([
      [MAINT, 1],
      [MAINT, 1],
      [WRITER, 2],
    ])
    expect(thread?.reviews.filter((r) => r.reviewer === STRANGER)).toHaveLength(100)
  })

  it('reads a long list that fits whole, and never the verdicts beside it', async () => {
    invalidateMembers(REPO_REF)
    const seen = newSeen()
    const thread = await loadPullThread(mockSdk(flooded(150), seen), REPO_REF, 1)
    expect(thread?.reviewsIncomplete).toBeUndefined()
    expect(thread?.reviews).toHaveLength(155)
    expect(thread?.approvals?.approvers).toEqual([MAINT])
    expect(seen.queries.some((q) => (q.where ?? []).some(([f, op]) => f === 'verdict' && op === '=='))).toBe(false)
  })
})
