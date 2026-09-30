/**
 * The sealed release writer (`private-repos.md` §16.3–§16.5; parity with forge-core
 * `create_sealed_release`): what a revision carries forward, when it rebuilds, stores and records
 * an asset list, the re-seal when the write key moves during the upload, the notes budget, and
 * the warning when the revision is not its tag's newest. The documents are posted to a scripted
 * write engine and opened back with the reader's codec.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Create = { documentType: string; data: Record<string, unknown> }
const creates: Create[] = []
let nextId = 0

vi.mock('../sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sdk')>()
  return {
    ...real,
    createDocumentIdempotent: vi.fn(async (_sdk: unknown, _a: unknown, p: Create) => {
      creates.push({ documentType: p.documentType, data: p.data })
      return { documentId: `DOC${++nextId}`, confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: null }
    }),
    queryDocumentsWithProof: vi.fn(async () => ({ documents: [] })),
  }
})

import type { EvoSDK } from '@dashevo/evo-sdk'
import { base58Encode } from '../auth/base58'
import {
  EpochKeys,
  IdSet,
  RELEASE_MAX_PLAINTEXT,
  buildReleaseTlv,
  encodeReleaseTlv,
  fitReleaseNotes,
  openRelease,
  openReleaseManifest,
  sealReleaseManifest,
  type OpenContext,
  type ReleaseFields,
  type ReleaseManifest,
} from '../private'
import { sealReleaseWithNonce } from '../private/testing'
import type { PlainDocument, WriteAuth } from '../sdk'
import type { RepoRef } from './contract'
import { PrivateWriteError } from './private-writes'
import { sealedReleases, type ReleaseList, type ReleaseView } from './releases'
import {
  assetListPlan,
  carriedFields,
  createSealedRelease,
  notNewestWarning,
  sealedWriteWarnings,
  sealedReleaseBudget,
  type SealedReleaseEnv,
} from './sealed-release'

const repoIdBytes = new Uint8Array(32).fill(0x11)
const ownerBytes = new Uint8Array(32).fill(0x22)
const OWNER = base58Encode(ownerBytes)
const REPO: RepoRef = {
  forge: { core: 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1', collab: 'C', community: 'M', group: 'G' },
  repoId: base58Encode(repoIdBytes),
  ownerId: OWNER,
  name: 'secret',
  visibility: 'private',
}
const sdk = {} as EvoSDK
const auth: WriteAuth = { identityId: OWNER, network: 'devnet', getSigningKeyWif: () => 'x' }
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const sha = async (b: Uint8Array): Promise<string> => hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)))
const file = (name: string, text: string) => ({ name, size: text.length, arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer })

let k0: EpochKeys
let k1: EpochKeys
let ctx: OpenContext
beforeEach(async () => {
  creates.length = 0
  k0 = await EpochKeys.import(repoIdBytes, 0, new Uint8Array(32).fill(1))
  k1 = await EpochKeys.import(repoIdBytes, 1, new Uint8Array(32).fill(2))
  ctx = {
    keys: new Map([
      [0, k0],
      [1, k1],
    ]),
    anchors: new Map([
      [0, { id: new Uint8Array(32).fill(9), height: 1 }],
      [1, { id: new Uint8Array(32).fill(8), height: 2 }],
    ]),
    members: new IdSet(),
  }
})

/** A release list read from sealed revisions of `fields` (oldest first), as `readReleases` gives it. */
async function listOf(...revisions: ReleaseFields[]): Promise<ReleaseList> {
  const docs = await Promise.all(
    revisions.map(async (f, i) => {
      const s = await sealReleaseWithNonce(k0, ownerBytes, f, new Uint8Array(12).fill(i + 1))
      return { $id: base58Encode(new Uint8Array(32).fill(i + 1)), $ownerId: OWNER, $createdAt: 100 * (i + 1), vis: 'private', delta: 0, tagName: s.tagName, epoch: 0, enc: s.enc } as PlainDocument
    }),
  )
  return sealedReleases(docs, ctx)
}

/** A scripted environment: `keys` answered in turn by `writeKeys` (the last one repeats). */
function envOf(before: ReleaseList, keys: EpochKeys[], manifest: ReleaseManifest | null = null) {
  const stored: Uint8Array[] = []
  const calls = { openManifest: 0, writeKeys: 0 }
  const env: SealedReleaseEnv = {
    requireMaintainer: async () => undefined,
    writeKeys: async () => keys[Math.min(calls.writeKeys++, keys.length - 1)] as EpochKeys,
    releases: async () => ({ list: before, keys: ctx.keys }),
    openManifest: async () => {
      calls.openManifest++
      if (manifest === null) throw new Error('no manifest')
      return manifest
    },
    store: async (sealed) => {
      stored.push(sealed)
      const h = await sha(sealed)
      return { sha256: h, sizeBytes: sealed.length, uris: [`https://pub.example/packs/${h}.pack`], confirmed: ['r2'], failures: [] }
    },
  }
  return { env, stored, calls }
}

/** The fields of the release document the writer posted, opened as a reader does. */
async function writtenFields(): Promise<{ fields: ReleaseFields; epoch: number }> {
  const c = creates.find((x) => x.documentType === 'release')
  expect(c).toBeDefined()
  const d = c!.data
  expect(Object.keys(d).sort()).toEqual(['delta', 'enc', 'epoch', 'repoId', 'tagName', 'vis'])
  const opened = await openRelease(ctx, { ownerId: ownerBytes, epoch: d['epoch'] as number, tagName: d['tagName'] as string, vis: d['vis'] as string, delta: d['delta'] as number, enc: d['enc'] as Uint8Array, hasPlaintextContent: false })
  expect(opened.status).toBe('readable')
  return { fields: (opened as { fields: ReleaseFields }).fields, epoch: d['epoch'] as number }
}

const PREV_HASH = 'cd'.repeat(32)
const full: ReleaseFields = {
  tag: 'v1.0.0',
  name: 'One',
  notes: 'the notes',
  targetOid: 'ab'.repeat(20),
  prerelease: true,
  draft: true,
  yanked: true,
  importedAuthor: 'alice',
  importedUrl: 'https://github.com/o/r/releases/tag/v1.0.0',
  importedCreatedAt: 1_700_000_000_000,
  assetManifest: PREV_HASH,
}

describe('carry-forward (§16.3: a revision is a complete statement)', () => {
  it('an edit of nothing carries every field: name, notes, target, provenance, flags, the yank and the list', async () => {
    const { env, stored, calls } = envOf(await listOf(full), [k0])
    await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0' }, env)
    const { fields } = await writtenFields()
    expect(fields).toEqual(full)
    expect(stored).toHaveLength(0)
    expect(calls.openManifest).toBe(0)
    expect(creates.map((c) => c.documentType)).toEqual(['release'])
  })

  it('an unpublish sets 0x08 and keeps the yank and everything else; a later revision without it publishes again', async () => {
    const { env } = envOf(await listOf(full), [k0])
    await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', unpublished: true }, env)
    expect((await writtenFields()).fields).toEqual({ ...full, unpublished: true })
    creates.length = 0
    const again = envOf(await listOf(full, { ...full, unpublished: true }), [k0])
    await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0' }, again.env)
    // The newest revision was the unpublish: its fields are carried, the flag is not.
    expect((await writtenFields()).fields).toEqual(full)
  })

  it('stated flags and name replace the carried ones; only an explicit un-yank un-yanks', async () => {
    const { env } = envOf(await listOf(full), [k0])
    await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', name: 'Renamed', draft: false, prerelease: false, yanked: false }, env)
    const { fields } = await writtenFields()
    expect(fields).toEqual({ ...full, name: 'Renamed', draft: undefined, prerelease: undefined, yanked: undefined })
  })

  it('a first revision carries nothing', () => {
    expect(carriedFields({ tagName: 'v2', notes: 'ignored here' }, undefined)).toEqual({ tag: 'v2' })
  })

  it('new notes that fit beside a list without notes reuse that list: nothing is opened, stored or recorded', async () => {
    const { env, stored, calls } = envOf(await listOf(full), [k0])
    await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', notes: 'new notes' }, env)
    expect((await writtenFields()).fields).toEqual({ ...full, notes: 'new notes' })
    expect(stored).toHaveLength(0)
    expect(calls.openManifest).toBe(0)
  })

  it('the plan: keep, reuse or rebuild', () => {
    const base = carriedFields({ tagName: 'v1.0.0' }, full)
    expect(assetListPlan(base, undefined, 0)).toBe('keep')
    expect(assetListPlan(base, 'short', 0)).toBe('reuse')
    expect(assetListPlan(base, 'x'.repeat(3000), 0)).toBe('rebuild')
    expect(assetListPlan(base, undefined, 1)).toBe('rebuild')
    // New notes replacing notes that continued in the list: the list's notes change.
    expect(assetListPlan({ ...base, notesContinue: true }, 'short', 0)).toBe('rebuild')
  })
})

describe('the asset list (§16.5)', () => {
  const H = 'ef'.repeat(32)
  const prev: ReleaseManifest = {
    v: 1,
    tag: 'v1.0.0',
    total: 2,
    source: 'https://github.com/o/r/releases/tag/v1.0.0',
    assets: [
      { name: 'app.tar.gz', sha256: H, sizeBytes: 10, uris: ['https://a.example/app'], sealedSha256: H, sealedSizeBytes: 100 },
      { name: 'LICENSE', sha256: '', sizeBytes: 0, uris: ['https://github.com/o/r/releases/download/v1.0.0/LICENSE'] },
    ],
  }

  it('new files: the previous list but the replaced asset, each file sealed and stored by its sealed hash, the list recorded as kind 4', async () => {
    const { env, stored, calls } = envOf(await listOf(full), [k0], prev)
    const r = await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', files: [file('app.tar.gz', 'new app bytes'), file('notes.txt', 'hello')] }, env)
    expect(calls.openManifest).toBe(1)
    expect(stored).toHaveLength(3) // two files, then the list
    expect(creates.map((c) => c.documentType)).toEqual(['packManifest', 'release'])
    const list = stored[2] as Uint8Array
    const listHash = await sha(list)
    const pm = creates[0]!.data
    expect(hexOf(pm['packHash'] as Uint8Array)).toBe(listHash)
    expect(pm).toMatchObject({ kind: 4, objectCount: 0, chunkCount: 0, storage: 1, sizeBytes: list.length, uris: [`https://pub.example/packs/${listHash}.pack`] })
    const { fields } = await writtenFields()
    expect(fields).toEqual({ ...full, assetManifest: listHash })
    const opened = await openReleaseManifest(list, list.length, Buffer.from(listHash, 'hex'), 'v1.0.0', false, ctx.keys)
    expect(opened.source).toBe(prev.source)
    expect(opened.assets.map((a) => a.name)).toEqual(['LICENSE', 'app.tar.gz', 'notes.txt'])
    const app = opened.assets.find((a) => a.name === 'app.tar.gz')!
    expect(app.sha256).toBe(await sha(new TextEncoder().encode('new app bytes')))
    expect(app.sizeBytes).toBe(13)
    // Named in storage (and the entry) by the sealed hash, never the plaintext one.
    expect(app.sealedSha256).toBe(await sha(stored[0] as Uint8Array))
    expect(app.sealedSizeBytes).toBe((stored[0] as Uint8Array).length)
    expect(app.uris).toEqual([`https://pub.example/packs/${app.sealedSha256}.pack`])
    expect(r.resolved.assets).toEqual(opened.assets)
  })

  it('refuses two files of one name before anything is read or stored', async () => {
    const { env, stored, calls } = envOf(await listOf(full), [k0], prev)
    await expect(createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', files: [file('a', '1'), file('a', '2')] }, env)).rejects.toThrow(/same name/)
    expect(stored).toHaveLength(0)
    expect(calls.writeKeys).toBe(0)
  })

  it('notes that do not fit: a prefix in enc, 0x10, the full notes in the list', async () => {
    const long = 'é'.repeat(2000)
    const { env, stored } = envOf(await listOf({ tag: 'v2' }), [k0])
    await createSealedRelease(sdk, auth, REPO, { tagName: 'v2', notes: long }, env)
    const { fields } = await writtenFields()
    expect(fields.notesContinue).toBe(true)
    expect(long.startsWith(fields.notes as string)).toBe(true)
    const list = stored[0] as Uint8Array
    const opened = await openReleaseManifest(list, list.length, Buffer.from(fields.assetManifest as string, 'hex'), 'v2', true, ctx.keys)
    expect(opened).toMatchObject({ total: 0, assets: [], notes: long })
  })

  it('a key that moved during the upload: everything is sealed and stored again under the new key, and the first attempt reported', async () => {
    const { env, stored } = envOf(await listOf(full), [k0, k1, k1], prev)
    const r = await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', files: [file('x.bin', 'x')] }, env)
    expect(stored).toHaveLength(4)
    expect(r.orphaned).toEqual([await sha(stored[0] as Uint8Array), await sha(stored[1] as Uint8Array)])
    expect(r.warnings.some((w) => r.orphaned.every((h) => w.message.includes(h)))).toBe(true)
    const { fields, epoch } = await writtenFields()
    expect(epoch).toBe(1)
    expect(fields.assetManifest).toBe(await sha(stored[3] as Uint8Array))
    const opened = await openReleaseManifest(stored[3] as Uint8Array, (stored[3] as Uint8Array).length, Buffer.from(fields.assetManifest as string, 'hex'), 'v1.0.0', false, new Map([[1, k1]]))
    expect(opened.assets.find((a) => a.name === 'x.bin')?.sealedSha256).toBe(await sha(stored[2] as Uint8Array))
  })

  it('the same epoch number under another key is a move too (the key check value)', async () => {
    const k0b = await EpochKeys.import(repoIdBytes, 0, new Uint8Array(32).fill(3))
    const { env, stored } = envOf(await listOf(full), [k0, k0b, k0b], prev)
    const r = await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', files: [file('x.bin', 'x')] }, env)
    expect(r.orphaned).toHaveLength(2)
    expect(stored).toHaveLength(4)
  })

  it('a key that moved twice: nothing is signed', async () => {
    const k2 = await EpochKeys.import(repoIdBytes, 2, new Uint8Array(32).fill(4))
    const { env } = envOf(await listOf(full), [k0, k1, k1, k2], prev)
    await expect(createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', files: [file('x.bin', 'x')] }, env)).rejects.toBeInstanceOf(PrivateWriteError)
    expect(creates.some((c) => c.documentType === 'release')).toBe(false)
  })

  it('a retry of an unconfirmed write re-signs exactly its revision under the same key, uploading nothing', async () => {
    const first = envOf(await listOf(full), [k0], prev)
    const r = await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', files: [file('x.bin', 'x')], intent: 'draft-1' }, first.env)
    creates.length = 0
    const retry = envOf(await listOf(full), [k0])
    await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', resolved: r.resolved, intent: 'draft-1' }, retry.env)
    expect(retry.stored).toHaveLength(0)
    expect((await writtenFields()).fields).toEqual(r.resolved.fields)
    const moved = envOf(await listOf(full), [k1])
    await expect(createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', resolved: r.resolved }, moved.env)).rejects.toThrow(/moved/)
  })
})

describe('fitReleaseNotes (forge-core `fit_notes` parity)', () => {
  const base: ReleaseFields = { tag: 'v2', name: 'Two' }

  it('the Rust test: short notes whole, 2000 × "é" continue with a prefix, empty notes left out', () => {
    expect(fitReleaseNotes(base, 'short notes')).toEqual({ fields: { ...base, notes: 'short notes' }, notesContinue: false })
    const long = 'é'.repeat(2000)
    const { fields, notesContinue } = fitReleaseNotes(base, long)
    expect(notesContinue && fields.notesContinue === true && fields.assetManifest !== undefined).toBe(true)
    // tag (5) + name (6) + flags (4) + manifest (35) = 50; room 1507 − 50 − 3 = 1454 bytes = 727 × "é"
    expect(fields.notes).toBe('é'.repeat(727))
    expect(buildReleaseTlv(fields).length).toBeLessThanOrEqual(RELEASE_MAX_PLAINTEXT)
    expect(fitReleaseNotes(base, '')).toEqual({ fields: base, notesContinue: false })
  })

  it('cuts on a character boundary: an odd room never splits a two-byte character', () => {
    // name "Twoo" is one byte longer: 1453 bytes of room, 726 characters
    const { fields } = fitReleaseNotes({ ...base, name: 'Twoo' }, 'é'.repeat(2000))
    expect(fields.notes).toBe('é'.repeat(726))
  })

  it('never over 1507, 0x10 always with TLV 21, and the prefix a prefix, for notes of every size and width', () => {
    const chars = ['a', 'é', '€', '😀']
    for (let n = 1400; n <= 5120; n += 97) {
      for (const c of chars) {
        const notes = c.repeat(Math.floor(n / new TextEncoder().encode(c).length))
        for (const f of [base, { ...base, assetManifest: 'ab'.repeat(32) }, { ...full, notes: undefined }]) {
          const r = fitReleaseNotes(f, notes)
          const tlv = encodeReleaseTlv(r.fields)
          expect(tlv.length).toBeLessThanOrEqual(RELEASE_MAX_PLAINTEXT)
          if (r.notesContinue) {
            expect(r.fields.assetManifest).toBeDefined()
            expect(notes.startsWith(r.fields.notes ?? '')).toBe(true)
          } else {
            expect(r.fields.notes).toBe(notes)
          }
          // Whatever it says, the TLV sealer accepts it.
          expect(() => buildReleaseTlv(r.fields)).not.toThrow()
        }
      }
    }
  })

  it('the budget counts TLV 21 when the revision names a list', () => {
    const notes = 'a'.repeat(1480)
    expect(sealedReleaseBudget(base, notes, false).notesContinue).toBe(false)
    // 35 more bytes for the list's hash: the same notes no longer fit whole.
    const withList = sealedReleaseBudget(base, notes, true)
    expect(withList.notesContinue).toBe(true)
    expect(withList.used).toBeLessThanOrEqual(withList.limit)
  })
})

describe('the warnings after the write (§16.3)', () => {
  const view = (id: string, createdAt: number, publisher = 'P'): ReleaseView => ({
    id, tagName: 'v1', name: '', notes: '', notesBody: '', omitted: null, published: null, yanked: false, delta: 0, assets: [], badAssets: 0, publisher, createdAt,
  })

  it('warns when ours is visible and older than the newest, naming the newer one', () => {
    const w = notNewestWarning({ current: [view('THEIRS', 20, 'Q')], previous: [view('OURS', 10)] }, 'v1', 'OURS')
    expect(w?.newer?.id).toBe('THEIRS')
    expect(w?.message).toMatch(/older than another maintainer's/)
  })

  it('says nothing when ours is the newest', () => {
    expect(notNewestWarning({ current: [view('OURS', 20)], previous: [view('OLD', 10)] }, 'v1', 'OURS')).toBeNull()
  })

  it('says the check could not be made when ours is not visible yet, or the read failed', () => {
    const unseen = notNewestWarning({ current: [view('THEIRS', 20)], previous: [] }, 'v1', 'OURS')
    expect(unseen?.message).toMatch(/not visible yet/)
    expect(unseen?.newer).toBeUndefined()
    expect(notNewestWarning(null, 'v1', 'OURS')?.message).toMatch(/not visible yet/)
  })

  it("an unpublished tag's newest is in the history, newest first", () => {
    const w = notNewestWarning({ current: [], previous: [view('THEIRS', 20), view('OURS', 10)] }, 'v1', 'OURS')
    expect(w?.newer?.id).toBe('THEIRS')
  })

  it('warns when the revision was carried from a view that misses a newer one (stale, or the tag in doubt)', () => {
    const after: ReleaseList = { current: [view('OURS', 20)], previous: [] }
    expect(sealedWriteWarnings('v1', { current: [], previous: [] }, after, 'OURS', [])).toEqual([])
    expect(sealedWriteWarnings('v1', { current: [], previous: [], stale: true }, after, 'OURS', [])[0]?.message).toMatch(/carried forward/)
    expect(sealedWriteWarnings('v1', { current: [], previous: [], unknownTags: ['v1'] }, after, 'OURS', [])).toHaveLength(1)
    expect(sealedWriteWarnings('v1', { current: [], previous: [], unknownTags: ['v2'] }, after, 'OURS', [])).toEqual([])
  })

  it('the writer returns it from a read after the write', async () => {
    const before = await listOf(full)
    const { env } = envOf(before, [k0])
    // After the write another maintainer's revision is newer than ours (`DOC…` is ours).
    let reads = 0
    const after: SealedReleaseEnv = {
      ...env,
      releases: async () => {
        reads++
        if (reads === 1) return { list: before, keys: ctx.keys }
        return { list: { current: [{ ...before.current[0]!, id: 'THEIRS' }], previous: [{ ...before.current[0]!, id: `DOC${nextId}` }] }, keys: ctx.keys }
      },
    }
    const r = await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', yanked: false }, after)
    expect(r.warnings.map((w) => w.newer?.id)).toEqual(['THEIRS'])
  })

  it('refuses a title or notes over their caps before anything is read', async () => {
    const { env, calls } = envOf(await listOf(full), [k0])
    await expect(createSealedRelease(sdk, auth, REPO, { tagName: 'v1', name: 'x'.repeat(121) }, env)).rejects.toThrow(/title/)
    await expect(createSealedRelease(sdk, auth, REPO, { tagName: 'v1', notes: 'é'.repeat(2561) }, env)).rejects.toThrow(/notes/)
    await expect(createSealedRelease(sdk, auth, REPO, { tagName: 'v1@{0}' }, env)).rejects.toThrow(/tag name/)
    expect(calls.writeKeys).toBe(0)
  })
})

describe('sealReleaseManifest round trip', () => {
  it('a manifest the writer seals opens under the reader rules', async () => {
    const m: ReleaseManifest = { v: 1, tag: 'v1', total: 0, assets: [] }
    const { sealed } = await sealReleaseManifest(k0, m)
    await expect(openReleaseManifest(sealed, sealed.length, Buffer.from(await sha(sealed), 'hex'), 'v1', false, ctx.keys)).resolves.toEqual(m)
  })
})
