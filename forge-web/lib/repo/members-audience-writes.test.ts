/**
 * The audience a composer chose, at write time (DESIGN §3.3, §4.1; stream 1D): a diff comment's
 * chosen audience is checked against its thread before anything is written, and a pending review
 * holding one members-only comment never reaches disk.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let stored: Record<string, Record<string, unknown>> = {}
const writes: { documentType: string; data: Record<string, unknown> }[] = []

vi.mock('../view/retry', () => ({ retryWhileMissing: vi.fn(async (f: () => Promise<unknown>) => f()) }))
vi.mock('./role-claim', async (orig) => ({ ...(await orig<typeof import('./role-claim')>()), roleClaim: async () => ({}) }))
vi.mock('../sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sdk')>()
  return {
    ...real,
    // The repo has a members key (a sealed config beside the plaintext one).
    queryAllDocuments: vi.fn(async (_sdk: unknown, q: { documentTypeName: string }) =>
      q.documentTypeName === 'config' ? [{ $id: 'c1', defaultBranch: 'main' }, { $id: 'c2', enc: Uint8Array.from([0x02, ...new Uint8Array(84)]), epoch: 0 }] : [],
    ),
    queryDocumentsWithProof: vi.fn(async (_sdk: unknown, q: { where?: [string, string, unknown][] }) => {
      const id = q.where?.find(([f]) => f === '$id')?.[2]
      const doc = typeof id === 'string' ? stored[id] : undefined
      return { documents: doc === undefined ? [] : [doc] }
    }),
    createDocumentIdempotent: vi.fn(async (_sdk: unknown, _a: unknown, p: { documentType: string; data: Record<string, unknown> }) => {
      writes.push({ documentType: p.documentType, data: p.data })
      return { documentId: '8rSFEyS7gidGdS4r8m22YtMEc519otpDNQ242Zw9c1Gb', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: null }
    }),
  }
})

import { base58Encode } from '../auth/base58'
import { idbEntries, resetMemoryStores } from '../idb'
import type { WriteAuth } from '../sdk'
import type { RepoRef } from './contract'
import { draftHasMembersText, loadReviewDraft, postComment, saveReviewDraft, type ReviewDraft } from './review-writes'
import { addDraftComment, draftQuotesMembersText, newReviewDraft, removeDraftComment, withMemoryOnly } from '../view/pending-review'

const id = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const b58 = (u: Uint8Array): string => base58Encode(u)
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const REPO: RepoRef = { forge: FORGE, repoId: b58(id(0x31)), ownerId: b58(id(0x41)), name: 'mixed', visibility: 'public' }
const sdk = {} as unknown as EvoSDK
const auth: WriteAuth = { identityId: b58(id(0x42)), network: 'devnet', getSigningKeyWif: () => 'x' }
const PR = b58(id(0x51))
const ROOT_MEMBERS = b58(id(0x61))
const SEALED = Uint8Array.from([0x03, ...new Uint8Array(60)])

beforeEach(() => {
  writes.length = 0
  resetMemoryStores()
  stored = {
    [PR]: { $id: PR, repoId: REPO.repoId, title: 'public PR' },
    [ROOT_MEMBERS]: { $id: ROOT_MEMBERS, repoId: REPO.repoId, enc: SEALED, epoch: 0 },
  }
})

describe("a diff comment's chosen audience", () => {
  it('a public reply in a members-only thread is refused before anything is written', async () => {
    await expect(postComment(sdk, auth, REPO, { targetId: PR, body: 'QAMARK public reply', replyTo: ROOT_MEMBERS, audience: 'public' })).rejects.toThrow(/members-only/)
    expect(writes).toEqual([])
  })

  it('a public comment on a public PR is written as asked', async () => {
    await postComment(sdk, auth, REPO, { targetId: PR, body: 'a public line', audience: 'public' })
    expect(writes.map((w) => w.data['body'])).toEqual(['a public line'])
  })
})

describe('a pending review with members-only comments', () => {
  const base = (): ReviewDraft => newReviewDraft({ draftId: 'd1', network: 'devnet', identity: auth.identityId, repoId: REPO.repoId, prId: PR, headOid: 'ab'.repeat(20), private: false, now: 1 })

  it('lives in memory while any comment is members-only, and goes back to disk once none is', async () => {
    const pub = addDraftComment(base(), 'l1', { path: 'a.rs', line: 1, side: 1 }, 'a public note')
    const mixed = addDraftComment(pub, 'l2', { path: 'a.rs', line: 2, side: 1 }, 'MEMBERS-ONLY-NOTE', 'members')
    expect(draftHasMembersText(pub)).toBe(false)
    expect(draftHasMembersText(mixed)).toBe(true)
    expect(mixed.comments.map((c) => c.audience ?? 'public')).toEqual(['public', 'members'])

    await saveReviewDraft(mixed, REPO)
    expect(JSON.stringify(await idbEntries('journal'))).not.toContain('MEMBERS-ONLY-NOTE')
    expect(JSON.stringify(await idbEntries('journal'))).not.toContain('a public note')
    expect((await loadReviewDraft('devnet', auth.identityId, PR))?.comments).toHaveLength(2)

    // The members-only comment removed: the draft is public again, kept on disk, no memory copy over it.
    const back = removeDraftComment(mixed, 'l2')
    await saveReviewDraft(back, REPO)
    expect(JSON.stringify(await idbEntries('journal'))).toContain('a public note')
    expect((await loadReviewDraft('devnet', auth.identityId, PR))?.comments.map((c) => c.body)).toEqual(['a public note'])
  })

  it('lives in memory while its public text quotes members-only text the page shows', async () => {
    const SECRET = 'The staging database password rotates on Friday at noon.'
    const quoting = { ...base(), summary: `> ${SECRET}\nAgreed.` }
    expect(draftQuotesMembersText(quoting, [SECRET])).toBe(true)
    expect(draftQuotesMembersText(quoting, [SECRET], 'members')).toBe(false)
    expect(draftQuotesMembersText({ ...quoting, audience: 'members' }, [SECRET])).toBe(false)
    expect(draftQuotesMembersText(addDraftComment(base(), 'l1', { path: 'a.rs', line: 1, side: 1 }, SECRET), [SECRET])).toBe(true)
    await saveReviewDraft(withMemoryOnly(quoting, draftQuotesMembersText(quoting, [SECRET])), REPO)
    expect(JSON.stringify(await idbEntries('journal'))).not.toContain('staging database')
    expect((await loadReviewDraft('devnet', auth.identityId, PR))?.summary).toContain('staging database')
    // The quote taken out: the mark goes, and the draft is back on disk.
    const clean = { ...quoting, summary: 'Agreed.' }
    await saveReviewDraft(withMemoryOnly({ ...clean, memoryOnly: true }, draftQuotesMembersText(clean, [SECRET])), REPO)
    expect(JSON.stringify(await idbEntries('journal'))).toContain('Agreed.')
  })

  it('drops a memory-only draft an earlier build left in IndexedDB', async () => {
    const { idbPut } = await import('../idb')
    await idbPut('journal', `review:devnet:${auth.identityId}:${PR}`, { ...base(), summary: 'QUOTED', memoryOnly: true })
    expect(await loadReviewDraft('devnet', auth.identityId, PR)).toBeUndefined()
    expect(JSON.stringify(await idbEntries('journal'))).not.toContain('QUOTED')
  })
})
