/**
 * A maintainer's make-public bundle (`./make-public-bundle`, DESIGN §4.6, §3.5): who may write
 * one, what is left out and why before anything is signed, and the bundle a write stores (the
 * `make_public__bundle_key_members_comment` vector's comment and key, the
 * `make_public__bundle_key_pr_members` vector's pull request and key; every key wiped after).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let stored: Record<string, Record<string, unknown>> = {}
let maintainers: string[] = []
let openedBody = 'Rotate the key on Friday.'
/** What the members-only PR opens to for this maintainer (its real branch names). */
const PR_FIELDS = { title: 'Fix the bounds check', body: 'The upper bound was off by one.', baseRefName: 'refs/heads/main', sourceRefName: 'refs/heads/sec/fix' }
let epochKeys: unknown = null
const artifacts: Uint8Array[] = []
const manifests: { kind: number; objectCount: number }[] = []
let lastArtifact: Uint8Array | null = null

vi.mock('../sdk', async (orig) => ({
  ...(await orig<typeof import('../sdk')>()),
  queryDocumentsWithProof: vi.fn(async (_sdk: unknown, q: { where?: [string, string, unknown][] }) => {
    const id = q.where?.find(([f]) => f === '$id')?.[2]
    const doc = typeof id === 'string' ? stored[id] : undefined
    return { documents: doc === undefined ? [] : [doc] }
  }),
}))
vi.mock('./members', async (orig) => ({ ...(await orig<typeof import('./members')>()), readMaintainers: vi.fn(async () => maintainers) }))
vi.mock('../auth/encryption-key', async (orig) => ({
  ...(await orig<typeof import('../auth/encryption-key')>()),
  encryptionOps: vi.fn(async () => ({})),
  fetchIdentityKeys: vi.fn(async () => []),
  // This maintainer was not sent any letter.
  withLetterReader: vi.fn(async () => {
    throw new Error('no slot for this reader')
  }),
}))
vi.mock('./private-session', async (orig) => ({
  ...(await orig<typeof import('./private-session')>()),
  sessionUnwrapper: vi.fn(() => null),
  loadPrivateSessionUncached: vi.fn(async () => (epochKeys === null ? null : { ctx: {}, resolution: { keys: new Map([[0, epochKeys]]) }, close: () => undefined })),
}))
vi.mock('../private', async (orig) => ({
  ...(await orig<typeof import('../private')>()),
  // The members-only post opens for this maintainer (the anchor and late rules are `doc.ts`'s own tests').
  openContent: vi.fn(async (d: { type: string }) => ({ status: 'readable', fields: d.type === 'patch' ? PR_FIELDS : { body: openedBody } })),
}))
vi.mock('./made-public', async (orig) => ({
  ...(await orig<typeof import('./made-public')>()),
  bundledFields: vi.fn(async () => null),
  readDocumentHistory: vi.fn(async () => []),
}))
vi.mock('../storage/upload', () => ({
  storeArtifact: vi.fn(async (_sdk: unknown, _auth: unknown, _repo: unknown, bytes: Uint8Array) => {
    lastArtifact = bytes
    artifacts.push(bytes.slice())
    return { packHash: 'ab'.repeat(32), sizeBytes: bytes.length, chunkCount: 1, storage: 1, uris: [] }
  }),
}))
vi.mock('./push', async (orig) => ({
  ...(await orig<typeof import('./push')>()),
  writePackManifest: vi.fn(async (_sdk: unknown, _auth: unknown, _repo: unknown, input: { kind: number; objectCount: number }) => {
    manifests.push({ kind: input.kind, objectCount: input.objectCount })
    return { documentId: 'm', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: null }
  }),
}))

import { base58Encode } from '../auth/base58'
import { PACK_KIND } from '../constants'
import { EpochKeys, parseBundle } from '../private'
import type { WriteAuth } from '../sdk'
import type { RepoRef } from './contract'
import { MakePublicRefusedError } from './make-public-writes'
import { canMakeOthersPublic, planMakePublicBundle, writeMakePublicBundle } from './make-public-bundle'

const readVector = <T,>(name: string): T => JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'forge-contracts', 'vectors', `${name}.json`), 'utf8')) as T
const vector = readVector<{
  input: { repoId: string; doc: { ownerId: string; targetId: string; id: string }; enc: string; epochKey: string }
  expected: { kObj: string }
}>('make_public__bundle_key_members_comment')
/** A members-only PR from a members-only branch into public main (the same repo, epoch key and author). */
const prVector = readVector<{
  input: { doc: { number: number; baseRefNameHash: string; sourceRefNameHash: string; id: string }; enc: string }
  expected: { kObj: string }
}>('make_public__bundle_key_pr_members')
const hex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16))
const toHex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('')
const b58 = (h: string): string => base58Encode(hex(h))
const id = (b: number): string => base58Encode(new Uint8Array(32).fill(b))

const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const OWNER = id(0x41)
const MAINT = id(0x42)
const WRITER = id(0x43)
const ALICE = b58(vector.input.doc.ownerId)
const REPO: RepoRef = { forge: FORGE, repoId: b58(vector.input.repoId), ownerId: OWNER, name: 'mixed', visibility: 'public' }
const sdk = {} as unknown as EvoSDK
const as = (identityId: string): WriteAuth => ({ identityId, network: 'devnet', getSigningKeyWif: () => 'x' })

const COMMENT = b58(vector.input.doc.id)
const PUBLIC_COMMENT = id(0x51)
const SEALED_PR = b58(prVector.input.doc.id)
const LETTER = id(0x53)

beforeEach(async () => {
  maintainers = [MAINT]
  openedBody = 'Rotate the key on Friday.'
  epochKeys = await EpochKeys.import(hex(vector.input.repoId), 0, hex(vector.input.epochKey))
  artifacts.length = 0
  manifests.length = 0
  lastArtifact = null
  const base = { repoId: REPO.repoId, $revision: 1, $createdAtBlockHeight: 10, vis: 'public', epoch: 0 }
  stored = {
    [COMMENT]: { ...base, $id: COMMENT, $ownerId: ALICE, targetId: b58(vector.input.doc.targetId), enc: hex(vector.input.enc) },
    [PUBLIC_COMMENT]: { ...base, $id: PUBLIC_COMMENT, $ownerId: ALICE, targetId: b58(vector.input.doc.targetId), body: 'public already', epoch: undefined },
    [SEALED_PR]: {
      ...base,
      $id: SEALED_PR,
      $ownerId: ALICE,
      number: prVector.input.doc.number,
      baseRefNameHash: hex(prVector.input.doc.baseRefNameHash),
      sourceRefNameHash: hex(prVector.input.doc.sourceRefNameHash),
      enc: hex(prVector.input.enc),
    },
    [LETTER]: { ...base, $id: LETTER, $ownerId: ALICE, targetId: b58(vector.input.doc.targetId), enc: Uint8Array.from([0x04, ...new Uint8Array(200)]) },
  }
})

describe('who may make other people’s posts public', () => {
  it('a writer is refused before anything is read or signed', async () => {
    await expect(planMakePublicBundle(sdk, as(WRITER), REPO, [{ type: 'comment', id: COMMENT }])).rejects.toThrow(/Only maintainers can make other people's posts public/)
    await expect(writeMakePublicBundle(sdk, as(WRITER), REPO, [{ type: 'comment', id: COMMENT }])).rejects.toBeInstanceOf(MakePublicRefusedError)
    expect(artifacts).toHaveLength(0)
    expect(await canMakeOthersPublic(sdk, REPO, WRITER)).toBe(false)
  })

  it('a maintainer and the owner may', async () => {
    expect(await canMakeOthersPublic(sdk, REPO, MAINT)).toBe(true)
    expect(await canMakeOthersPublic(sdk, REPO, OWNER)).toBe(true)
    expect(await canMakeOthersPublic(sdk, REPO, null)).toBe(false)
  })

  it('a private repo is refused', async () => {
    await expect(planMakePublicBundle(sdk, as(MAINT), { ...REPO, visibility: 'private' }, [{ type: 'comment', id: COMMENT }])).rejects.toThrow(/This repo is private/)
  })
})

describe('what a bundle leaves out, before signing', () => {
  it('a public post and a message not sent to the maintainer are left out with the reason; a pull request’s own text is not', async () => {
    const plan = await planMakePublicBundle(sdk, as(MAINT), REPO, [
      { type: 'comment', id: PUBLIC_COMMENT },
      { type: 'patch', id: SEALED_PR },
      { type: 'comment', id: LETTER },
      { type: 'comment', id: COMMENT },
    ])
    expect(plan.leftOut.map((l) => [l.id, l.why])).toEqual([
      [PUBLIC_COMMENT, 'alreadyPublic'],
      [LETTER, 'notSent'],
    ])
    expect(plan.posts.map((p) => [p.id, p.author, p.text])).toEqual([
      [SEALED_PR, ALICE, 'Fix the bounds check\nThe upper bound was off by one.'],
      [COMMENT, ALICE, 'Rotate the key on Friday.'],
    ])
    expect(plan.entries).toBe(2)
  })

  it('a pull request from a members-only branch: its branch’s name stays members-only, the public base’s does not', async () => {
    const plan = await planMakePublicBundle(sdk, as(MAINT), REPO, [{ type: 'patch', id: SEALED_PR }])
    expect(plan.posts.map((p) => [p.type, p.number, p.membersBranches])).toEqual([['patch', prVector.input.doc.number, 1]])
    expect(plan.leftOut).toEqual([])
  })

  it('a post whose text continues in a separate members-only artifact is left out', async () => {
    openedBody = `The start.\n\n<!-- forge:body sha256=${'0'.repeat(64)} bytes=99999 -->`
    const plan = await planMakePublicBundle(sdk, as(MAINT), REPO, [{ type: 'comment', id: COMMENT }])
    expect(plan.leftOut.map((l) => l.why)).toEqual(['longBody'])
  })

  it('without the members key in this browser the post is unreadable to the maintainer', async () => {
    epochKeys = null
    const plan = await planMakePublicBundle(sdk, as(MAINT), REPO, [{ type: 'comment', id: COMMENT }])
    expect(plan.leftOut.map((l) => l.why)).toEqual(['unreadable'])
  })

  it('nothing left to publish: refused, nothing stored', async () => {
    await expect(writeMakePublicBundle(sdk, as(MAINT), REPO, [{ type: 'comment', id: PUBLIC_COMMENT }])).rejects.toThrow(/nothing to make public/)
    expect(artifacts).toHaveLength(0)
    expect(manifests).toHaveLength(0)
  })
})

describe('the bundle a maintainer writes', () => {
  it('one entry per post with the key that commits to it, stored as a kind-7 manifest, its bytes wiped after', async () => {
    const { plan } = await writeMakePublicBundle(sdk, as(MAINT), REPO, [{ type: 'comment', id: COMMENT }])
    expect(plan.posts).toHaveLength(1)
    expect(manifests).toEqual([{ kind: PACK_KIND.MAKE_PUBLIC, objectCount: 0 }])
    const bundle = parseBundle(artifacts[0] as Uint8Array)
    expect(bundle.entries).toHaveLength(1)
    const [e] = bundle.entries
    expect(e?.kind).toBe(0x01)
    expect(toHex(e?.target ?? new Uint8Array())).toBe(vector.input.doc.id)
    expect(e?.revision).toBe(1)
    expect(toHex(e?.key ?? new Uint8Array())).toBe(vector.expected.kObj)
    // the encoded bytes this tab held are zero now
    expect(lastArtifact?.every((b) => b === 0)).toBe(true)
  })

  it('a pull request’s entry is type 0x04 with the K_obj the members key derives for it', async () => {
    const { plan } = await writeMakePublicBundle(sdk, as(MAINT), REPO, [{ type: 'patch', id: SEALED_PR }])
    expect(plan.posts.map((p) => p.revisions)).toEqual([[1]])
    const [e, ...rest] = parseBundle(artifacts[0] as Uint8Array).entries
    expect(rest).toEqual([])
    expect([e?.kind, toHex(e?.target ?? new Uint8Array()), e?.revision, toHex(e?.key ?? new Uint8Array())]).toEqual([0x04, prVector.input.doc.id, 1, prVector.expected.kObj])
  })
})
