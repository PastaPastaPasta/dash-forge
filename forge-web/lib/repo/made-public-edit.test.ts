/**
 * After a maintainer's bundle covers a members-only issue or comment, its author's edits are
 * written as Public (DESIGN §4.6, "after a bundle"): the R5 replace (plaintext set, `enc` and
 * `epoch` removed), never a re-seal, so the public and members never see different current text.
 * A pull request's edit stays sealed: a public edit cannot keep its sealed branch names.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let stored: Record<string, Record<string, unknown>> = {}
const replaces: { documentType: string; changes: Record<string, unknown> }[] = []
let configs: Record<string, unknown>[] = []
let coveredBy: string | null = null

// sakura's contracts: none of the mainnet fields (`mainnet-fields.ts`), `vis` where it was
vi.mock('./contract-shape', async (orig) => {
  const real = await orig<typeof import('./contract-shape')>()
  const mainnet = new Set(['aud', 'mRole', 'tAud', 'enc', 'asMaintainer'])
  return {
    ...real,
    contractHasProperty: async (...a: Parameters<typeof real.contractHasProperty>) => (mainnet.has(a[3]) ? false : a[3] === 'vis' ? true : real.contractHasProperty(...a)),
    contractPropertyMinimum: async () => null,
  }
})
vi.mock('../view/retry', () => ({ retryWhileMissing: vi.fn(async (f: () => Promise<unknown>) => f()) }))
vi.mock('./made-public', async (orig) => ({ ...(await orig<typeof import('./made-public')>()), bundleCovers: vi.fn(async () => coveredBy) }))
vi.mock('../sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sdk')>()),
  queryAllDocuments: vi.fn(async (_sdk: unknown, q: { documentTypeName: string }) => (q.documentTypeName === 'config' ? configs : [])),
  queryDocumentsWithProof: vi.fn(async (_sdk: unknown, q: { where?: [string, string, unknown][] }) => {
    const id = q.where?.find(([f]) => f === '$id')?.[2]
    const doc = typeof id === 'string' ? stored[id] : undefined
    return { documents: doc === undefined ? [] : [doc] }
  }),
  precheckEdit: vi.fn(async () => undefined),
  replaceDocumentIdempotent: vi.fn(async (_sdk: unknown, _a: unknown, p: { documentType: string; changes: Record<string, unknown> }) => {
    replaces.push({ documentType: p.documentType, changes: p.changes })
    return { documentId: 'x', revision: 3n, cost: { credits: 0, dash: 0 }, actualCredits: null }
  }),
}))

import { base58Encode } from '../auth/base58'
import type { WriteAuth } from '../sdk'
import type { RepoRef } from './contract'
import { updateComment, updateTarget } from './review-writes'

const id = (b: number): string => base58Encode(new Uint8Array(32).fill(b))
const BOB = id(0x42)
const MAINT = id(0x44)
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const REPO: RepoRef = { forge: FORGE, repoId: id(0x31), ownerId: id(0x41), name: 'mixed', visibility: 'public' }
const sdk = {} as unknown as EvoSDK
const auth: WriteAuth = { identityId: BOB, network: 'devnet', getSigningKeyWif: () => 'x' }
const SEALED = Uint8Array.from([0x03, ...new Uint8Array(60)])
const ISSUE_PUBLIC = id(0x51)
const COMMENT = id(0x61)
const ISSUE = id(0x62)
const PR = id(0x63)

beforeEach(() => {
  configs = [{ $id: 'c1', defaultBranch: 'main' }, { $id: 'c2', enc: Uint8Array.from([0x02, ...new Uint8Array(84)]), epoch: 0 }]
  replaces.length = 0
  coveredBy = null
  const sealed = { repoId: REPO.repoId, $ownerId: BOB, enc: SEALED, epoch: 0, asMember: BOB, vis: 'public', $revision: 2 }
  stored = {
    [ISSUE_PUBLIC]: { $id: ISSUE_PUBLIC, repoId: REPO.repoId, $ownerId: id(0x43), title: 'public', vis: 'public' },
    [COMMENT]: { $id: COMMENT, ...sealed, targetId: ISSUE_PUBLIC },
    [ISSUE]: { $id: ISSUE, ...sealed, number: 4 },
    [PR]: { $id: PR, ...sealed, number: 5, baseRefNameHash: new Uint8Array(32).fill(1), sourceRefNameHash: new Uint8Array(32).fill(2), headOid: new Uint8Array(20).fill(3) },
  }
})

describe('an author’s edit of a post a maintainer made public', () => {
  it('a comment is written as Public: the text in plaintext, enc and epoch removed', async () => {
    coveredBy = MAINT
    await updateComment(sdk, auth, REPO, { id: COMMENT, body: 'Edited after it went public.', expectedRevision: 2n })
    expect(replaces).toHaveLength(1)
    const c = replaces[0]?.changes ?? {}
    expect(c['body']).toBe('Edited after it went public.')
    expect('enc' in c && c['enc'] === undefined).toBe(true)
    expect('epoch' in c && c['epoch'] === undefined).toBe(true)
  })

  it('an issue’s title edit keeps its body and goes public with it', async () => {
    coveredBy = MAINT
    await updateTarget(sdk, auth, REPO, {
      type: 'issue',
      id: ISSUE,
      title: 'A new title',
      expectedRevision: 2n,
      seal: { bind: {}, current: { title: 'old', body: 'The published body.' } } as never,
    })
    const c = replaces[0]?.changes ?? {}
    expect(c['title']).toBe('A new title')
    expect(c['body']).toBe('The published body.')
    expect('enc' in c && c['enc'] === undefined).toBe(true)
  })

  it('a pull request’s edit stays members-only (H1): a public edit would lose its sealed branch names and real head', async () => {
    coveredBy = MAINT
    // without its sealing context it is refused, never replaced with plaintext
    await expect(updateTarget(sdk, auth, REPO, { type: 'patch', id: PR, body: 'An edited description.', expectedRevision: 2n })).rejects.toThrow(/members-only, and an edit keeps who can read it/)
    expect(replaces).toEqual([])
  })

  it('not covered: the members-only comment is never replaced with plaintext', async () => {
    await expect(updateComment(sdk, auth, REPO, { id: COMMENT, body: 'still members-only', expectedRevision: 2n })).rejects.toThrow(/members-only, and an edit keeps who can read it/)
    expect(replaces).toEqual([])
  })
})
