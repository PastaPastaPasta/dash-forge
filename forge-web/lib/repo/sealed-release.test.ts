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
  TooLargeError,
  buildReleaseTlv,
  encodeReleaseTlv,
  fitReleaseNotes,
  openRelease,
  openReleaseManifest,
  sealPack,
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
  headerFits,
  listStates,
  notNewestWarning,
  retryMovedWarning,
  sealedWriteWarnings,
  sealedReleaseBudget,
  sealedReleasePreview,
  type SealedReleaseEnv,
  type SealedReleaseInput,
} from './sealed-release'
import type { PackManifest } from './packs'

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

/** The first 36 bytes of the object in `objects` whose SHA-256 is `sealedSha256` (a storage read of its header). */
async function headerOf(objects: readonly Uint8Array[], sealedSha256: string | undefined): Promise<Uint8Array> {
  for (const o of objects) if ((await sha(o)) === sealedSha256) return o.slice(0, 36)
  throw new Error('not stored')
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
    storedLists: async () => [],
    storedHeader: async (entry) => headerOf(stored, entry.sealedSha256),
    store: async (sealed, sha256Hex) => {
      stored.push(sealed)
      const h = await sha(sealed)
      expect(sha256Hex).toBe(h)
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
    // Carried notes that no longer fit beside a longer name are fitted again.
    expect(assetListPlan({ ...base, name: 'n'.repeat(120), notes: 'x'.repeat(1400) }, undefined, 0)).toBe('rebuild')
  })

  it('carried whole notes pushed over the budget by a longer name continue in a new list, never a refusal', async () => {
    const near: ReleaseFields = { tag: 'v3', name: 'a', notes: 'x'.repeat(1480) }
    const { env, stored } = envOf(await listOf(near), [k0])
    await createSealedRelease(sdk, auth, REPO, { tagName: 'v3', name: 'n'.repeat(120) }, env)
    const { fields } = await writtenFields()
    expect(fields).toMatchObject({ name: 'n'.repeat(120), notesContinue: true })
    const list = stored[0] as Uint8Array
    const opened = await openReleaseManifest(list, list.length, Buffer.from(fields.assetManifest as string, 'hex'), 'v3', true, ctx.keys)
    expect(opened.notes).toBe(near.notes)
  })

  it('the composer preview: the budget, whether a list is stored, and its cost', () => {
    const edit = sealedReleasePreview(carriedFields({ tagName: 'v1.0.0' }, full), '', 0)
    expect(edit).toMatchObject({ notesContinue: false, storesList: false })
    expect(edit.used).toBe(encodeReleaseTlv(full).length)
    const withFile = sealedReleasePreview(carriedFields({ tagName: 'v1.0.0' }, full), '', 1)
    expect(withFile.storesList).toBe(true)
    expect(withFile.cost.credits).toBeGreaterThan(edit.cost.credits)
    const longNotes = sealedReleasePreview({ tag: 'v2' }, 'x'.repeat(3000), 0)
    expect(longNotes).toMatchObject({ notesContinue: true, storesList: true })
    expect(longNotes.used).toBeLessThanOrEqual(longNotes.limit)
    expect(sealedReleasePreview({ tag: 'v2' }, 'short', 0)).toMatchObject({ notesContinue: false, storesList: false })
    // Short notes replacing notes that continued in an unopened list: kept only if it holds assets.
    const replaced = sealedReleasePreview({ tag: 'v2', notes: 'start', notesContinue: true, assetManifest: 'ab'.repeat(32) }, 'short', 0)
    expect(replaced).toMatchObject({ notesContinue: false, storesList: 'maybe' })
  })

  it('a retry names its own tag', async () => {
    const { env } = envOf(await listOf(full), [k0])
    const resolved = { fields: { tag: 'v9' }, epoch: 0, kcv: hexOf(k0.kcv), assets: [], carriedId: null }
    await expect(createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', resolved }, env)).rejects.toThrow(/v9/)
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

describe('a re-run after a failed release write (§16.5: the stored asset list is reused)', () => {
  const H = 'ef'.repeat(32)
  const prev: ReleaseManifest = {
    v: 1,
    tag: 'v1.0.0',
    total: 1,
    assets: [{ name: 'app.tar.gz', sha256: H, sizeBytes: 10, uris: ['https://a.example/app'], sealedSha256: H, sealedSizeBytes: 100 }],
  }
  const x = file('x.bin', 'x')

  /** An attempt that stored its files and list under `keys`; its release write "failed" (the re-run's list does not show it). */
  async function storedByAnAttempt(keys: EpochKeys, input: SealedReleaseInput = { tagName: 'v1.0.0', files: [x] }, carried: ReleaseFields = full) {
    const first = envOf(await listOf(carried), [keys], prev)
    const r = await createSealedRelease(sdk, auth, REPO, input, first.env)
    const objects = first.stored
    const list = first.stored[first.stored.length - 1] as Uint8Array
    const hash = r.resolved.fields.assetManifest as string
    creates.length = 0
    const record: PackManifest = {
      packHash: hash,
      kind: 4,
      sizeBytes: list.length,
      objectCount: 0,
      chunkCount: 0,
      storage: 1,
      uris: [`https://pub.example/packs/${hash}.pack`],
      tips: [],
      supersedes: [],
      createdAt: 1000,
      documentId: 'PM1',
      uploader: OWNER,
    }
    return { list, hash, record, objects, assets: r.resolved.assets }
  }

  /**
   * A re-run's environment: the lists it finds, each opened with the keyring the writer passes (the
   * carried one is `prev`), and the earlier attempt's objects still in storage.
   */
  function rerunEnv(
    before: ReleaseList,
    keys: EpochKeys[],
    stored: { list: Uint8Array; hash: string; record: PackManifest; objects: readonly Uint8Array[] },
    lists = [stored.record],
    objects = stored.objects,
  ) {
    const e = envOf(before, keys, prev)
    const opened: string[] = []
    e.env.storedLists = async () => lists
    e.env.storedHeader = async (entry) => headerOf(objects, entry.sealedSha256)
    e.env.openManifest = async (fields, ring) => {
      if (fields.assetManifest === PREV_HASH) return prev
      opened.push(fields.assetManifest as string)
      if (fields.assetManifest !== stored.hash) throw new Error('not stored')
      return openReleaseManifest(stored.list, stored.list.length, Buffer.from(stored.hash, 'hex'), fields.tag, fields.notesContinue === true, ring)
    }
    return { ...e, opened }
  }

  it('names the list the failed attempt stored: nothing sealed, uploaded or recorded again', async () => {
    const s = await storedByAnAttempt(k0)
    const rerun = rerunEnv(await listOf(full), [k0], s)
    const events: string[] = []
    const r = await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', files: [x] }, rerun.env, (e) => events.push(e.step))
    expect(rerun.stored).toHaveLength(0)
    expect(creates.map((c) => c.documentType)).toEqual(['release'])
    expect((await writtenFields()).fields).toEqual({ ...full, assetManifest: s.hash })
    expect(events).toContain('reused')
    expect(r.resolved.assets).toEqual(s.assets)
  })

  it('builds a new list when the stored one states other files, or none of the signer’s is unnamed and newer', async () => {
    const s = await storedByAnAttempt(k0)
    const other = rerunEnv(await listOf(full), [k0], s)
    await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', files: [file('x.bin', 'y')] }, other.env)
    expect(other.opened).toEqual([s.hash])
    expect(other.stored).toHaveLength(2) // the file, then the list
    for (const record of [
      { ...s.record, uploader: base58Encode(new Uint8Array(32).fill(0x33)) }, // another signer's
      { ...s.record, createdAt: 50 }, // older than the carried revision
    ]) {
      creates.length = 0
      const e = rerunEnv(await listOf(full), [k0], s, [record])
      await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', files: [x] }, e.env)
      expect(e.opened).toEqual([])
      expect(e.stored).toHaveLength(2)
    }
    // Named by a readable revision (of any tag): that revision's list, not a failed attempt's.
    creates.length = 0
    const named = rerunEnv(await listOf(full, { tag: 'v0.9', assetManifest: s.hash }), [k0], s)
    await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', files: [x] }, named.env)
    expect(named.opened).toEqual([])
    expect(named.stored).toHaveLength(2)
  })

  it('builds a new list under the new key when the epoch moved since the failed attempt', async () => {
    const s = await storedByAnAttempt(k0)
    const moved = rerunEnv(await listOf(full), [k1], s)
    await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', files: [x] }, moved.env)
    // Opened under the write key only: the epoch-0 list does not open.
    expect(moved.opened).toEqual([s.hash])
    expect(moved.stored).toHaveLength(2)
    const { fields, epoch } = await writtenFields()
    expect(epoch).toBe(1)
    expect(fields.assetManifest).not.toBe(s.hash)
  })

  it('builds a new list when a file the earlier attempt stored is no longer in storage', async () => {
    const s = await storedByAnAttempt(k0)
    const gone = rerunEnv(await listOf(full), [k0], s, [s.record], [s.list])
    await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', files: [x] }, gone.env)
    expect(gone.opened).toEqual([s.hash])
    expect(gone.stored).toHaveLength(2)
    expect((await writtenFields()).fields.assetManifest).not.toBe(s.hash)
  })

  it('reuses a list that holds only continued notes', async () => {
    const long = 'é'.repeat(2000)
    const input = { tagName: 'v2', notes: long }
    const s = await storedByAnAttempt(k0, input, { tag: 'v2' })
    const rerun = rerunEnv(await listOf({ tag: 'v2' }), [k0], s)
    await createSealedRelease(sdk, auth, REPO, input, rerun.env)
    expect(rerun.stored).toHaveLength(0)
    const { fields } = await writtenFields()
    expect(fields).toMatchObject({ notesContinue: true, assetManifest: s.hash })
  })

  it('a reused list whose key then moves is reported as named by nothing, and a new one is sealed', async () => {
    const s = await storedByAnAttempt(k0)
    const rerun = rerunEnv(await listOf(full), [k0, k1, k1], s)
    const events: string[] = []
    const r = await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', files: [x] }, rerun.env, (e) => events.push(e.step))
    expect(events.filter((e) => e === 'reused' || e === 'resealing')).toEqual(['reused', 'resealing'])
    // the earlier attempt's file, then its list: both under the old key, named by nothing
    expect(r.orphaned).toEqual([s.assets.find((a) => a.name === 'x.bin')?.sealedSha256, s.hash])
    expect(rerun.stored).toHaveLength(2)
    expect((await writtenFields()).epoch).toBe(1)
  })

  it('listStates: the kept entries as they are, then each new file sealed, the notes and the source', () => {
    const kept = [{ name: 'old', sha256: H, sizeBytes: 1, uris: ['https://a/old'], sealedSha256: H, sealedSizeBytes: 53 }]
    const added = { name: 'new', sha256: 'aa'.repeat(32), sizeBytes: 5, uris: ['https://a/new'], sealedSha256: 'bb'.repeat(32), sealedSizeBytes: 57 }
    const m: ReleaseManifest = { v: 1, tag: 't', total: 2, assets: [...kept, added] }
    const want = { kept, files: [{ name: 'new', sha256: 'aa'.repeat(32), sizeBytes: 5 }], notes: undefined, source: undefined }
    expect(listStates(m, want)).toBe(true)
    const other = (change: Partial<typeof added>) => listStates({ ...m, assets: [...kept, { ...added, ...change }] }, want)
    expect(other({ name: 'x' })).toBe(false)
    expect(other({ sha256: 'cc'.repeat(32) })).toBe(false)
    expect(other({ sizeBytes: 6 })).toBe(false)
    expect(listStates({ ...m, assets: [...kept, { name: 'new', sha256: 'aa'.repeat(32), sizeBytes: 5, uris: ['https://src/new'] }] }, want)).toBe(false) // an external link
    expect(listStates({ ...m, assets: [{ ...kept[0]!, uris: [] }, added] }, want)).toBe(false) // a kept entry changed
    expect(listStates({ ...m, assets: kept }, want)).toBe(false) // a file missing
    expect(listStates({ ...m, notes: 'n' }, want)).toBe(false)
    expect(listStates({ ...m, source: 'https://s' }, want)).toBe(false)
  })

  it('headerFits: sealed under the write epoch at the recorded size', async () => {
    const sealed = await sealPack(k1, new TextEncoder().encode('hello'))
    const entry = { name: 'f', sha256: '', sizeBytes: 5, uris: [], sealedSha256: 'x', sealedSizeBytes: sealed.length }
    expect(headerFits(sealed.slice(0, 36), entry, 1)).toBe(true)
    expect(headerFits(sealed.slice(0, 36), entry, 0)).toBe(false)
    expect(headerFits(sealed.slice(0, 36), { ...entry, sealedSizeBytes: sealed.length + 1 }, 1)).toBe(false)
    expect(headerFits(sealed.slice(0, 20), entry, 1)).toBe(false)
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
    expect(w?.message).toMatch(/older than another one/)
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

describe('the 1 MiB cap on an asset list (§16.5)', () => {
  // About 2.5 KB of entry each: 8 URIs of 300 bytes.
  const big = (i: number) => ({
    name: `asset-${i}.bin`,
    sha256: 'ab'.repeat(32),
    sizeBytes: 1,
    uris: Array.from({ length: 8 }, (_, u) => `https://mirror${u}.example/${'x'.repeat(270)}/${i}`),
    sealedSha256: 'cd'.repeat(32),
    sealedSizeBytes: 100,
  })
  const huge = (n: number): ReleaseManifest => ({ v: 1, tag: 'v1.0.0', total: n, assets: Array.from({ length: n }, (_, i) => big(i)) })

  it('sealReleaseManifest refuses a sealed list readers would refuse unread', async () => {
    await expect(sealReleaseManifest(k0, huge(440))).rejects.toBeInstanceOf(TooLargeError)
    await expect(sealReleaseManifest(k0, huge(10))).resolves.toBeDefined()
  })

  it('the writer refuses such a list before storing anything', async () => {
    const { env, stored } = envOf(await listOf(full), [k0], huge(440))
    await expect(createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', files: [file('one-more.bin', 'x')] }, env)).rejects.toThrow(/1 MiB/)
    expect(stored).toHaveLength(0)
    expect(creates).toHaveLength(0)
  })
})

describe('a retry after another revision landed (§16.3)', () => {
  const view = (id: string, fields: ReleaseFields): ReleaseView => ({
    id, tagName: fields.tag, name: '', notes: '', notesBody: '', omitted: null, published: null, yanked: false, delta: 0, assets: [], badAssets: 0, publisher: 'P', createdAt: 1,
    sealed: { epoch: 0, fields },
  })
  const resolved = { fields: { tag: 'v1', name: 'Mine' }, epoch: 0, kcv: '', assets: [], carriedId: 'CARRIED' }

  it('warns when the newest is neither the carried revision nor its own earlier attempt', () => {
    expect(retryMovedWarning({ current: [view('CARRIED', { tag: 'v1' })], previous: [] }, resolved)).toBeNull()
    // Its own attempt landed: the same statement.
    expect(retryMovedWarning({ current: [view('LANDED', { tag: 'v1', name: 'Mine' })], previous: [] }, resolved)).toBeNull()
    const w = retryMovedWarning({ current: [view('THEIRS', { tag: 'v1', name: 'Theirs' })], previous: [] }, resolved)
    expect(w?.newer?.id).toBe('THEIRS')
    expect(retryMovedWarning(null, resolved)).toBeNull()
  })

  it('the writer records the carried revision and the retry reports the newer one', async () => {
    const first = envOf(await listOf(full), [k0])
    const r = await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', yanked: false }, first.env)
    expect(r.resolved.carriedId).toBe(base58Encode(new Uint8Array(32).fill(1)))
    const newer = await listOf(full, { ...full, name: 'Theirs' })
    const retry = envOf(newer, [k0])
    const again = await createSealedRelease(sdk, auth, REPO, { tagName: 'v1.0.0', resolved: r.resolved }, retry.env)
    expect(again.warnings.some((w) => /prepared from/.test(w.message))).toBe(true)
  })
})
