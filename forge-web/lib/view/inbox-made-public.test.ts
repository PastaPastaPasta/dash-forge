/**
 * The inbox's "made your post public" items (`./inbox-made-public`, DESIGN §4.6): one per
 * maintainer's bundle whose key really opens my posts (the `make_public__bundle_read_thread`
 * vector's issue, comment and review, all by one author, and its maintainer's bundle); a writer's
 * bundle, my own, a lying entry and a bundle naming only other people's posts make none.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let maintainers: string[] = []
let posts: Record<string, Record<string, unknown>> = {}
let configs: Record<string, unknown>[] = []
const artifacts = new Map<string, Uint8Array>()

vi.mock('../repo/members', async (orig) => ({ ...(await orig<typeof import('../repo/members')>()), readMaintainers: vi.fn(async () => maintainers) }))
vi.mock('./browse-source', () => ({
  loadStoredArtifactBytes: vi.fn(async (_sdk: unknown, _repo: unknown, m: { packHash: string }) => {
    const b = artifacts.get(m.packHash)
    if (b === undefined) throw new Error('no copy could be read')
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
  queryAllDocuments: vi.fn(async () => configs),
}))

import { base58Encode } from '../auth/base58'
import { ENTRY_COMMENT, ENTRY_EPOCH_KEY, encodeBundle, encodeDocBundle, parseBundle, type BundleEntry } from '../private'
import { madePublicItems } from './inbox-made-public'

const vector = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'forge-contracts', 'vectors', 'make_public__bundle_read_thread.json'), 'utf8')) as {
  input: {
    repoId: string
    maintainers: string[]
    bundles: { owner: string; bytes: string }[]
    docs: { doc: { type: string; ownerId: string; epoch: number; id: string; number?: number; targetId?: string; patchId?: string; vis: string }; enc: string; revision: number }[]
  }
}
const hex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16))
const b58 = (h: string): string => base58Encode(hex(h))

/** The thread issue's title, as the bundle publishes it. */
const TITLE = (JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'forge-contracts', 'vectors', 'make_public__bundle_read_thread.json'), 'utf8')) as { expected: { reads: { fields: { title: string } }[] } }).expected.reads[0]!.fields.title
const ME = b58(vector.input.docs[0]!.doc.ownerId)
const OWNER = b58(vector.input.maintainers[0]!)
const MAINT = b58(vector.input.bundles[0]!.owner)
const WRITER = base58Encode(new Uint8Array(32).fill(0xc0))
const OTHER = base58Encode(new Uint8Array(32).fill(0x04))
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const REPO = { id: b58(vector.input.repoId), ownerId: OWNER, name: 'mixed', private: false }
const sdk = {} as unknown as EvoSDK
/** The thread bundle's entries: the issue's, the comment's and the review's, with their real keys. */
const THREAD = hex(vector.input.bundles[0]!.bytes)
const entries = (): readonly BundleEntry[] => parseBundle(THREAD).entries
const commentEntry = (): BundleEntry => entries().find((e) => e.kind === ENTRY_COMMENT) as BundleEntry

/** A kind-7 manifest of `uploader` whose artifact is `bytes`. */
function manifest(n: number, uploader: string, bytes: Uint8Array): Record<string, unknown> {
  const hash = n.toString(16).padStart(2, '0').repeat(32)
  artifacts.set(hash, bytes)
  return { $id: base58Encode(new Uint8Array(32).fill(0x70 + n)), $ownerId: uploader, $createdAt: 1_000 + n, kind: 7, packHash: hash, sizeBytes: bytes.length, chunkCount: 1, storage: 1 }
}

const only = (e: BundleEntry, key = e.key): Uint8Array => encodeDocBundle([{ kind: e.kind, target: e.target, revision: e.revision, key }])

beforeEach(() => {
  configs = []
  maintainers = [OWNER, MAINT]
  artifacts.clear()
  posts = {}
  for (const { doc: d, enc, revision } of vector.input.docs) {
    posts[b58(d.id)] = {
      $id: b58(d.id),
      $ownerId: b58(d.ownerId),
      $revision: revision,
      repoId: REPO.id,
      vis: d.vis,
      epoch: d.epoch,
      enc: hex(enc),
      ...(d.number !== undefined ? { number: d.number } : {}),
      ...(d.targetId !== undefined ? { targetId: b58(d.targetId) } : {}),
      ...(d.patchId !== undefined ? { patchId: b58(d.patchId), verdict: 3 } : {}),
    }
  }
})

describe('the inbox item when a maintainer makes my posts public', () => {
  it('one post: "made your comment public", by the maintainer, linked to its thread', async () => {
    const items = await madePublicItems(sdk, FORGE, REPO, [manifest(1, MAINT, only(commentEntry()))], ME)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'madePublic', what: 'made your comment public', actor: MAINT, at: 1_001, target: { kind: 'issue', number: 7 } })
  })

  it('a whole thread in one bundle: one item', async () => {
    const items = await madePublicItems(sdk, FORGE, REPO, [manifest(2, MAINT, THREAD)], ME)
    expect(items.map((i) => i.what)).toEqual(['made 3 of your posts public'])
    // the members-only issue reads by the title the bundle published, not its placeholder
    expect(items[0]?.target?.title).toBe(TITLE)
  })

  it('a lying entry, a writer’s bundle, my own bundle, and someone else’s posts make none', async () => {
    const lie = only(commentEntry(), new Uint8Array(32).fill(9))
    expect(await madePublicItems(sdk, FORGE, REPO, [manifest(3, MAINT, lie), manifest(4, WRITER, THREAD), manifest(5, ME, THREAD)], ME)).toEqual([])
    expect(await madePublicItems(sdk, FORGE, REPO, [manifest(6, MAINT, THREAD)], OTHER)).toEqual([])
  })

  it('the owner’s bundle counts; a private repo makes none', async () => {
    const doc = manifest(7, OWNER, only(commentEntry()))
    expect(await madePublicItems(sdk, FORGE, REPO, [doc], ME)).toHaveLength(1)
    expect(await madePublicItems(sdk, FORGE, { ...REPO, private: true }, [doc], ME)).toEqual([])
  })

  it('the owner publishing what was written while the repo was private: said once, to everyone else', async () => {
    const history = encodeBundle([{ kind: ENTRY_EPOCH_KEY, target: hex(vector.input.repoId), revision: 0, key: new Uint8Array(32).fill(5) }], 'made public')
    // a repo never private: an owner's entry there publishes nothing (readers ignore it)
    configs = [{ $id: base58Encode(new Uint8Array(32).fill(0x90)), $createdAt: 10, $createdAtBlockHeight: 1, vis: 'public' }]
    expect(await madePublicItems(sdk, FORGE, REPO, [manifest(9, OWNER, history)], OTHER)).toEqual([])
    configs = [{ $id: base58Encode(new Uint8Array(32).fill(0x91)), $createdAt: 5, $createdAtBlockHeight: 1, epoch: 0, enc: 'AQ==', vis: 'private' }, ...configs]
    const items = await madePublicItems(sdk, FORGE, REPO, [manifest(10, OWNER, history), manifest(11, OWNER, history)], OTHER)
    expect(items).toEqual([{ id: `repoPublic:${REPO.id}:everything`, kind: 'repoPublic', repo: REPO, what: 'made everything written while private public', actor: OWNER, at: 1_010, read: false }])
    // the owner's own bundle is no news to them
    expect(await madePublicItems(sdk, FORGE, REPO, [manifest(12, OWNER, history)], OWNER)).toEqual([])
  })

  it('a bundle that cannot be read fails the page, so the feed reads it again', async () => {
    const doc = manifest(8, MAINT, THREAD)
    artifacts.clear()
    await expect(madePublicItems(sdk, FORGE, REPO, [doc], ME)).rejects.toThrow(/no copy/)
  })
})
