/**
 * The inbox's "made your post public" items (`./inbox-made-public`, DESIGN §4.6): one per
 * maintainer's bundle that names my posts; a writer's bundle, my own, and a bundle naming only
 * other people's posts make none.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let maintainers: string[] = []
let posts: Record<string, Record<string, unknown>> = {}
const artifacts = new Map<string, Uint8Array>()

vi.mock('../repo/members', async (orig) => ({ ...(await orig<typeof import('../repo/members')>()), readMaintainers: vi.fn(async () => maintainers) }))
vi.mock('./browse-source', () => ({
  loadStoredArtifactBytes: vi.fn(async (_sdk: unknown, _repo: unknown, m: { packHash: string }) => {
    const b = artifacts.get(m.packHash)
    if (b === undefined) throw new Error('no such artifact')
    return b
  }),
}))
vi.mock('./mine', async (orig) => ({
  ...(await orig<typeof import('./mine')>()),
  readTargetsByIds: vi.fn(async (_sdk: unknown, _forge: unknown, ids: readonly string[]) => new Map(ids.map((id) => [id, { kind: 'issue', number: 7, title: 'Key rotation' }]))),
}))
vi.mock('../sdk', async (orig) => ({
  ...(await orig<typeof import('../sdk')>()),
  queryDocumentsWithProof: vi.fn(async (_sdk: unknown, q: { where?: [string, string, unknown][] }) => {
    const id = q.where?.find(([f]) => f === '$id')?.[2]
    const doc = typeof id === 'string' ? posts[id] : undefined
    return { documents: doc === undefined ? [] : [doc] }
  }),
}))

import { base58Encode } from '../auth/base58'
import { ENTRY_COMMENT, ENTRY_ISSUE, encodeDocBundle } from '../private'
import { madePublicItems } from './inbox-made-public'

const id = (b: number): string => base58Encode(new Uint8Array(32).fill(b))
const raw = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const ME = id(0x01)
const MAINT = id(0x02)
const WRITER = id(0x03)
const OTHER = id(0x04)
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const REPO = { id: id(0x31), ownerId: id(0x30), name: 'mixed', private: false }
const sdk = {} as unknown as EvoSDK
const ISSUE = 0x51
const MY_COMMENT = 0x52
const MY_ISSUE = 0x53
const THEIR_COMMENT = 0x54

/** A kind-7 manifest of `uploader` whose artifact is a bundle naming `entries`. */
function manifest(n: number, uploader: string, entries: { kind: number; target: number }[]): Record<string, unknown> {
  const hash = n.toString(16).padStart(2, '0').repeat(32)
  artifacts.set(hash, encodeDocBundle(entries.map((e) => ({ kind: e.kind, target: raw(e.target), revision: 1, key: new Uint8Array(32).fill(9) }))))
  return { $id: id(0x70 + n), $ownerId: uploader, $createdAt: 1_000 + n, kind: 7, packHash: hash, sizeBytes: 76, chunkCount: 1, storage: 1 }
}

beforeEach(() => {
  maintainers = [MAINT]
  artifacts.clear()
  posts = {
    [id(MY_COMMENT)]: { $id: id(MY_COMMENT), repoId: REPO.id, $ownerId: ME, targetId: id(ISSUE) },
    [id(MY_ISSUE)]: { $id: id(MY_ISSUE), repoId: REPO.id, $ownerId: ME, number: 8 },
    [id(THEIR_COMMENT)]: { $id: id(THEIR_COMMENT), repoId: REPO.id, $ownerId: OTHER, targetId: id(ISSUE) },
  }
})

describe('the inbox item when a maintainer makes my posts public', () => {
  it('one post: "made your comment public", by the maintainer, linked to its thread', async () => {
    const items = await madePublicItems(sdk, FORGE, REPO, [manifest(1, MAINT, [{ kind: ENTRY_COMMENT, target: MY_COMMENT }, { kind: ENTRY_COMMENT, target: THEIR_COMMENT }])], ME)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'madePublic', what: 'made your comment public', actor: MAINT, at: 1_001, target: { kind: 'issue', number: 7 } })
  })

  it('several of my posts in one bundle: one item', async () => {
    const items = await madePublicItems(sdk, FORGE, REPO, [manifest(2, MAINT, [{ kind: ENTRY_COMMENT, target: MY_COMMENT }, { kind: ENTRY_ISSUE, target: MY_ISSUE }])], ME)
    expect(items.map((i) => i.what)).toEqual(['made 2 of your posts public'])
  })

  it('a writer’s bundle, my own bundle, and one naming only other people’s posts make none', async () => {
    const docs = [
      manifest(3, WRITER, [{ kind: ENTRY_COMMENT, target: MY_COMMENT }]),
      manifest(4, ME, [{ kind: ENTRY_COMMENT, target: MY_COMMENT }]),
      manifest(5, MAINT, [{ kind: ENTRY_COMMENT, target: THEIR_COMMENT }]),
    ]
    expect(await madePublicItems(sdk, FORGE, REPO, docs, ME)).toEqual([])
  })

  it('the owner’s bundle counts; a private repo makes none', async () => {
    const doc = manifest(6, REPO.ownerId, [{ kind: ENTRY_COMMENT, target: MY_COMMENT }])
    expect(await madePublicItems(sdk, FORGE, REPO, [doc], ME)).toHaveLength(1)
    expect(await madePublicItems(sdk, FORGE, { ...REPO, private: true }, [doc], ME)).toEqual([])
  })
})
