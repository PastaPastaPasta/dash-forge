/**
 * The maintainers' make-public bundles in front of a content gate (`./made-public`, DESIGN §4.6):
 * the `make_public__bundle_read_*` vectors' bundles and documents, read through `withBundles` as a
 * page reads them. An anonymous reader's gate admits nothing sealed, so whatever is admitted here
 * was opened by a bundle alone.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let maintainers: string[] = []
let bundles: { owner: Uint8Array; bytes: Uint8Array }[] = []

vi.mock('./members', async (orig) => ({ ...(await orig<typeof import('./members')>()), readMaintainers: vi.fn(async () => maintainers) }))
vi.mock('./converted', async (orig) => ({
  ...(await orig<typeof import('./converted')>()),
  // As the reader does: only the bundles of the uploaders it asks for are read.
  readMakePublicBundles: vi.fn(async (_sdk: unknown, _repo: unknown, uploaders: ReadonlySet<string>) => bundles.filter((b) => uploaders.has(base58Encode(b.owner)))),
}))

import { base58Encode } from '../auth/base58'
import type { PlainDocument } from '../sdk'
import type { RepoRef } from './contract'
import { bundleCovers, invalidateRepoBundles, withBundles } from './made-public'
import { EDITED_AFTER_PUBLIC, MADE_PUBLIC_BY, type Admission, type ContentGate } from './private-content'

const VECTORS = join(__dirname, '..', '..', '..', 'forge-contracts', 'vectors')
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }

interface ReadVector {
  readonly input: {
    readonly repoId: string
    readonly visibility: 'public' | 'private'
    readonly maintainers: readonly string[]
    readonly bundles: readonly { readonly owner: string; readonly bytes: string }[]
    readonly docs: readonly {
      readonly doc: { readonly type: 'comment' | 'issue' | 'review'; readonly ownerId: string; readonly epoch: number; readonly id: string; readonly targetId?: string; readonly patchId?: string; readonly number?: number; readonly vis?: string }
      readonly enc: string
      readonly revision: number
    }[]
  }
}

const hex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16))
const b58 = (h: string): string => base58Encode(hex(h))

function load(name: string): ReadVector {
  return JSON.parse(readFileSync(join(VECTORS, `make_public__bundle_read_${name}.json`), 'utf8')) as ReadVector
}

/** The vector's repository (owned by its first maintainer) and its documents as Platform returns them. */
function setUp(name: string, visibility?: 'public' | 'private'): { repo: RepoRef; docs: { type: 'comment' | 'issue' | 'review'; doc: PlainDocument }[] } {
  const v = load(name).input
  maintainers = v.maintainers.map(b58)
  bundles = v.bundles.map((b) => ({ owner: hex(b.owner), bytes: hex(b.bytes) }))
  const repo: RepoRef = { forge: FORGE, repoId: b58(v.repoId), ownerId: maintainers[0] as string, name: 'mixed', visibility: visibility ?? v.visibility }
  invalidateRepoBundles(repo)
  const docs = v.docs.map(({ doc: d, enc, revision }) => ({
    type: d.type,
    doc: {
      $id: b58(d.id),
      $ownerId: b58(d.ownerId),
      $revision: revision,
      repoId: repo.repoId,
      ...(d.vis !== undefined ? { vis: d.vis } : {}),
      epoch: d.epoch,
      enc: hex(enc),
      ...(d.targetId !== undefined ? { targetId: b58(d.targetId) } : {}),
      ...(d.patchId !== undefined ? { patchId: b58(d.patchId), verdict: 3 } : {}),
      ...(d.number !== undefined ? { number: d.number } : {}),
    } as PlainDocument,
  }))
  return { repo, docs }
}

/** An anonymous reader's gate: nothing sealed opens, a members-only post is its placeholder. */
const anonymous = (visibility: RepoRef['visibility']): ContentGate => ({
  visibility,
  admit: async () => ({ ok: false, reason: 'membersOnly', placeholder: { audience: 'members' } }) as unknown as Admission,
})

const sdk = {} as unknown as EvoSDK

beforeEach(() => {
  maintainers = []
  bundles = []
})

describe('a maintainer’s bundle in front of the gate', () => {
  it('an anonymous reader reads a bundled comment as public, with who made it public', async () => {
    const { repo, docs } = setUp('maintainer_bundle_public')
    const [{ type, doc }] = docs as [(typeof docs)[number]]
    const a = await withBundles(sdk, repo, anonymous(repo.visibility)).admit(type, doc)
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(String(a.doc['body'])).toMatch(/^members-only: /)
    expect(a.doc['enc']).toBeUndefined()
    expect(a.doc[MADE_PUBLIC_BY]).toBe(maintainers[1])
    expect(a.alerts).toBeUndefined()
    // the author's edit of it is written as Public from now on
    expect(await bundleCovers(sdk, repo, type, doc)).toBe(maintainers[1])
  })

  it('the owner’s bundle counts too, listed as a maintainer or not', async () => {
    const { repo, docs } = setUp('owner_bundle_public')
    maintainers = maintainers.filter((m) => m !== repo.ownerId)
    const [{ type, doc }] = docs as [(typeof docs)[number]]
    expect((await withBundles(sdk, repo, anonymous(repo.visibility)).admit(type, doc)).ok).toBe(true)
  })

  it('a writer’s bundle is ignored, with no alert', async () => {
    const { repo, docs } = setUp('writer_bundle_ignored')
    const [{ type, doc }] = docs as [(typeof docs)[number]]
    const a = await withBundles(sdk, repo, anonymous(repo.visibility)).admit(type, doc)
    expect(a.ok).toBe(false)
    expect(a.alerts).toBeUndefined()
    expect(await bundleCovers(sdk, repo, type, doc)).toBeNull()
  })

  it('a lying entry is an alert naming its maintainer, and the post stays a placeholder', async () => {
    const { repo, docs } = setUp('lying_entry_alert')
    const [{ type, doc }] = docs as [(typeof docs)[number]]
    const a = await withBundles(sdk, repo, anonymous(repo.visibility)).admit(type, doc)
    expect(a.ok).toBe(false)
    expect(a.alerts).toEqual([{ id: doc['$id'], revision: 1, by: maintainers[1], author: doc['$ownerId'] }])
  })

  it('a lying entry next to an honest one: public, and the lie is still said', async () => {
    const { repo, docs } = setUp('lying_then_honest')
    const [{ type, doc }] = docs as [(typeof docs)[number]]
    const a = await withBundles(sdk, repo, anonymous(repo.visibility)).admit(type, doc)
    expect(a.ok).toBe(true)
    expect(a.alerts?.length).toBe(1)
  })

  it('a comment its author sealed again afterwards keeps its placeholder, marked edited after it was made public', async () => {
    const { repo, docs } = setUp('edited_after')
    const [{ type, doc }] = docs as [(typeof docs)[number]]
    const a = await withBundles(sdk, repo, anonymous(repo.visibility)).admit(type, doc)
    expect(a.ok).toBe(false)
    if (a.ok) return
    expect(a.placeholder?.editedAfterBy).toBe(maintainers[1])
  })

  it('a member’s own admission of an edited-after comment carries the mark', async () => {
    const { repo, docs } = setUp('edited_after')
    const [{ type, doc }] = docs as [(typeof docs)[number]]
    const member: ContentGate = { visibility: repo.visibility, admit: async (_t, d) => ({ ok: true, doc: { ...d, enc: undefined, body: 'the new members-only text' } }) }
    const a = await withBundles(sdk, repo, member).admit(type, doc)
    expect(a.ok && a.doc[EDITED_AFTER_PUBLIC]).toBe(maintainers[1])
    expect(a.ok && a.doc[MADE_PUBLIC_BY]).toBeUndefined()
  })

  it('a forged copy minted under a published key is not covered: only the document its entry names opens', async () => {
    const { repo, docs } = setUp('forged_copy_not_covered')
    const gate = withBundles(sdk, repo, anonymous(repo.visibility))
    const admitted = await Promise.all(docs.map(({ type, doc }) => gate.admit(type, doc)))
    expect(admitted.map((a) => a.ok)).toEqual([false])
  })

  it('a private repository honours no bundle and reads none', async () => {
    const { repo, docs } = setUp('maintainer_bundle_public', 'private')
    const [{ type, doc }] = docs as [(typeof docs)[number]]
    const inner = anonymous(repo.visibility)
    expect(withBundles(sdk, repo, inner)).toBe(inner)
    expect(await bundleCovers(sdk, repo, type, doc)).toBeNull()
  })

  it('a whole thread: the issue and its comments open, each by its own entry', async () => {
    const { repo, docs } = setUp('thread')
    const gate = withBundles(sdk, repo, anonymous(repo.visibility))
    const admitted = await Promise.all(docs.map(({ type, doc }) => gate.admit(type, doc)))
    const expected = (load('thread') as unknown as { expected: { reads: { state: string }[] } }).expected.reads.map((r) => r.state === 'public')
    expect(admitted.map((a) => a.ok)).toEqual(expected)
  })
})
