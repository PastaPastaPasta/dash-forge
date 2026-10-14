/**
 * A repository made public, read in the browser (`private-repos.md` §18; forge-core
 * `converted_repo_tests`): the published keys reach a session that holds no key share, its gate
 * opens the earlier discussion by each document's own `vis`, and the browse plane skips a pack
 * sealed under a key nobody published before downloading it, or opens it with the published keys.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./pack-mirrors', async (orig) => ({ ...(await orig<typeof import('./pack-mirrors')>()), mirrorUrisOf: async () => [] }))

import { base58Decode, base58Encode } from '../auth/base58'
import { CHUNK_PAYLOAD_MAX } from '../constants'
import { ENTRY_EPOCH_KEY, EpochKeys, encodeBundle, sealDoc, sealPack, type PrivateDoc, type PrivateDocType } from '../private'
import type { Membership } from '../rules/v2'
import { bytesToBase64, type PlainDocument } from '../sdk'
import { PackSkippedError, clearChunkCache, loadArtifactBytesProgress, loadBrowseContext, skippedGitPacks } from '../view/browse-source'
import { serializeLocator } from '../browse/indexer'
import { readAboutTotals, repoSizeOf } from '../view/repo-facts'
import { invalidateSessionCache } from '../view/session-cache'
import { mockSdk, newSeen, type Doc } from './drive-mock'
import type { RepoRef } from './contract'
import { knownConversion, recordConversion } from './converted'
import type { PackManifest } from './packs'
import { privateGate } from './private-content'
import { loadPrivateSession, type PrivateSession, type SessionSource } from './private-session'

const id = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const b58 = (u: Uint8Array): string => base58Encode(u)
const REPO_ID = id(0x11)
const OWNER = id(0x21)
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const REPO: RepoRef = { forge: FORGE, repoId: b58(REPO_ID), ownerId: b58(OWNER), name: 'opened', visibility: 'public' }
const K0 = Uint8Array.from({ length: 32 }, (_, i) => i)
const K1 = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i)
const NOBODY = b58(new Uint8Array(32))

let seq = 0
const docId = (): string => b58(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? ++seq : 0x70)))

/** A sealed v0x01 document of the private era, stamped `vis: "private"`, in the shape a query returns. */
async function sealedDoc(type: PrivateDocType, keys: EpochKeys, bind: Partial<PrivateDoc>, fields: Parameters<typeof sealDoc>[2], extra: PlainDocument, height: number, anchor = false): Promise<PlainDocument> {
  const enc = await sealDoc(keys, { type, ownerId: OWNER, epoch: keys.epoch, ...bind }, fields, { anchor })
  return { $id: docId(), $ownerId: b58(OWNER), $createdAt: height * 1000, $createdAtBlockHeight: height, repoId: b58(REPO_ID), epoch: keys.epoch, enc: bytesToBase64(enc), vis: 'private', ...extra }
}

/** Epochs 0 and 1 anchored while private (1 chains to 0), then the plaintext config of the flip at height 40. */
async function timeline(): Promise<PlainDocument[]> {
  const k0 = await EpochKeys.import(REPO_ID, 0, K0)
  const k1 = await EpochKeys.import(REPO_ID, 1, K1)
  return [
    await sealedDoc('config', k0, {}, { defaultBranch: 'main' }, {}, 10, true),
    await sealedDoc('config', k1, {}, { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) }, {}, 20, true),
    { $id: docId(), $ownerId: b58(OWNER), $createdAt: 40_000, $createdAtBlockHeight: 40, repoId: b58(REPO_ID), defaultBranch: 'main', vis: 'public' },
  ]
}

const MEMBERS: Membership[] = [{ identity: b58(OWNER), role: 'maintainer', createdAt: 1 }]

/** The session a reader with no key share gets: only what the owner published in `bundles`. */
async function published(configs: PlainDocument[], bundles: Uint8Array[]): Promise<PrivateSession> {
  const source: SessionSource = {
    memberships: async () => MEMBERS,
    configs: async () => configs,
    repoKeys: async () => [],
    identityKeys: async () => null,
    makePublicBundles: async () => bundles.map((bytes) => ({ owner: OWNER, bytes })),
  }
  return loadPrivateSession({ repo: REPO, network: 'devnet', reader: NOBODY, source, unwrapper: null, published: true })
}

const epochKey = (epoch: number, key: Uint8Array) => ({ kind: ENTRY_EPOCH_KEY, target: REPO_ID, revision: epoch, key })

describe('the published keys of a repository made public', () => {
  it('reach a reader with no key share: the earlier discussion opens by its own vis', async () => {
    const configs = await timeline()
    const k0 = await EpochKeys.import(REPO_ID, 0, K0)
    const comment = await sealedDoc('comment', k0, { targetId: id(0x33) }, { body: 'from the private era' }, { targetId: b58(id(0x33)) }, 15)
    // epoch 1 is the seal-off epoch: only epoch 0 may be published
    const s = await published(configs, [encodeBundle([epochKey(0, K0), epochKey(1, K1)], 'made public')])
    expect(s.conversion).toEqual({ sealOffEpoch: 1, markerHeight: 40 })
    expect([...s.resolution.keys.keys()]).toEqual([0])
    expect([...s.publishedEpochs]).toEqual([0])
    const opened = await s.gate.admit('comment', comment)
    expect(opened.ok && opened.doc['body']).toBe('from the private era')
    // nothing published: the same comment is a members-only placeholder, never an error
    const none = await published(configs, [])
    expect(none.resolution.keys.size).toBe(0)
    expect(await none.gate.admit('comment', comment)).toMatchObject({ ok: false, reason: 'membersOnly', placeholder: { why: 'noKey' } })
    // a later client's envelope is members-only to this reader, never malformed
    const later = { ...comment, enc: bytesToBase64(Uint8Array.from([0x06, ...new Uint8Array(60)])) }
    expect(await s.gate.admit('comment', later)).toMatchObject({ ok: false, reason: 'unknownVersion' })
    // a bot's post (v0x05) from someone with no Bot row is never opened (§23); to a reader holding the key it says so
    const notABot = { ...comment, enc: bytesToBase64(Uint8Array.from([0x05, ...new Uint8Array(60)])) }
    expect(await s.gate.admit('comment', notABot)).toMatchObject({ ok: false, reason: 'notABot', placeholder: { why: 'notABot' } })
    // without the key it is the plain members-only placeholder
    expect(await none.gate.admit('comment', notABot)).toMatchObject({ ok: false, reason: 'membersOnly', placeholder: { why: 'noKey' } })
  })

  it('a key that does not match its anchor is ignored, and said so', async () => {
    const s = await published(await timeline(), [encodeBundle([epochKey(0, K1)], '')])
    expect(s.resolution.keys.size).toBe(0)
    expect(s.resolution.alerts).toEqual([{ kind: 'publishedKeyMismatch', epoch: 0, author: OWNER }])
  })

  it('a document stamped public in a private repository is malformed', async () => {
    const s = await published(await timeline(), [encodeBundle([epochKey(0, K0)], '')])
    const k0 = await EpochKeys.import(REPO_ID, 0, K0)
    const doc = await sealedDoc('comment', k0, { targetId: id(0x33) }, { body: 'x' }, { targetId: b58(id(0x33)), vis: 'public' }, 15)
    expect(await privateGate({ ...REPO, visibility: 'private' }, s.ctx).admit('comment', doc)).toEqual({ ok: false, reason: 'notEncrypted' })
  })
})

/** An sdk serving `bytes` as one Platform pack's chunks, recording each chunk query's seqs. */
function chunkSdk(bytes: Uint8Array, queried: number[][]): EvoSDK {
  return {
    documents: {
      query: async (q: { where?: readonly (readonly unknown[])[] }): Promise<Map<string, unknown>> => {
        const seqs = ((q.where ?? []).find((w) => w[0] === 'seq')?.[2] as number[]) ?? []
        const packClause = (q.where ?? []).find((w) => w[0] === 'packHash')
        expect(bytesToHex(base58Decode(String(packClause?.[2] ?? '')))).toBe(bytesToHex(sha256(bytes)))
        queried.push(seqs)
        const out = new Map<string, unknown>()
        for (const s of seqs) {
          const from = s * CHUNK_PAYLOAD_MAX
          if (from < bytes.length) out.set(`c${s}`, { seq: s, d0: bytesToBase64(bytes.subarray(from, Math.min(from + CHUNK_PAYLOAD_MAX, bytes.length))) })
        }
        return out
      },
    },
  } as unknown as EvoSDK
}

function manifestOf(bytes: Uint8Array, height: number): PackManifest {
  return {
    packHash: bytesToHex(sha256(bytes)),
    kind: 0,
    sizeBytes: bytes.length,
    objectCount: 0,
    chunkCount: Math.ceil(bytes.length / CHUNK_PAYLOAD_MAX),
    storage: 0,
    uris: [],
    tips: [],
    supersedes: [],
    createdAt: height * 1000,
    documentId: docId(),
    uploader: b58(OWNER),
    createdAtBlockHeight: height,
  }
}

describe("a repository made public's packs", () => {
  let configs: PlainDocument[]
  let plain: Uint8Array
  let sealed: Uint8Array
  beforeEach(async () => {
    clearChunkCache()
    configs = await timeline()
    recordConversion(REPO, configs)
    plain = Uint8Array.from({ length: CHUNK_PAYLOAD_MAX * 2 + 99 }, (_, i) => (i * 7) % 251)
    plain.set(new TextEncoder().encode('PACK'))
    sealed = await sealPack(await EpochKeys.import(REPO_ID, 0, K0), plain)
  })

  it('knows the repo was made public from its config timeline', () => {
    expect(knownConversion(REPO.repoId)).toEqual({ sealOffEpoch: 1, markerHeight: 40 })
  })

  it('skips a pack sealed under a key nobody published before downloading it', async () => {
    const queried: number[][] = []
    const load = loadArtifactBytesProgress(chunkSdk(sealed, queried), REPO, manifestOf(sealed, 20))
    await expect(load).rejects.toBeInstanceOf(PackSkippedError)
    await expect(load).rejects.toMatchObject({ why: { reason: 'noKey', epoch: 0 } })
    // only the first chunk (its header) was read
    expect(queried).toEqual([[0]])
  })

  it('skips a sealed pack of a public repo not yet known to be made public, once downloaded (never handed on sealed)', async () => {
    const unread: RepoRef = { ...REPO, repoId: b58(id(0x12)) }
    await expect(loadArtifactBytesProgress(chunkSdk(sealed, []), unread, manifestOf(sealed, 20))).rejects.toMatchObject({ why: { reason: 'noKey', epoch: 0 } })
  })

  it('skips a sealed header of another version, whoever holds keys', async () => {
    const other = sealed.slice()
    other[4] = 0x02
    const keys = await published(configs, [encodeBundle([epochKey(0, K0)], '')])
    await expect(loadArtifactBytesProgress(chunkSdk(other, []), { ...REPO, published: keys }, manifestOf(other, 20))).rejects.toMatchObject({ why: { reason: 'otherFormat', version: 2 } })
  })

  it('a private repo skips a sealed header of another version too, never reading it as corrupt', async () => {
    const other = sealed.slice()
    other[4] = 0x03
    const s = await published(configs, [encodeBundle([epochKey(0, K0)], '')])
    const repo: RepoRef = { ...REPO, visibility: 'private', session: s }
    await expect(loadArtifactBytesProgress(chunkSdk(other, []), repo, manifestOf(other, 20))).rejects.toMatchObject({ why: { reason: 'otherFormat', version: 3 } })
  })

  it('opens a pack sealed under a published key, and hands a plaintext one on as it is', async () => {
    const keys = await published(configs, [encodeBundle([epochKey(0, K0)], '')])
    const repo: RepoRef = { ...REPO, published: keys }
    expect(bytesToHex(await loadArtifactBytesProgress(chunkSdk(sealed, []), repo, manifestOf(sealed, 20)))).toBe(bytesToHex(plain))
    // pushed after the marker: never sniffed before the download, read as it is
    const queried: number[][] = []
    expect(bytesToHex(await loadArtifactBytesProgress(chunkSdk(plain, queried), repo, manifestOf(plain, 50)))).toBe(bytesToHex(plain))
    expect(queried.flat().sort()).toEqual([0, 1, 2])
  })
})

describe("a repository made public's size (R9)", () => {
  let configs: PlainDocument[]
  let open0: Uint8Array
  let members1: Uint8Array
  let fresh: Uint8Array
  beforeEach(async () => {
    clearChunkCache()
    invalidateSessionCache('')
    configs = await timeline()
    recordConversion(REPO, configs)
    const plain = (n: number, salt: number): Uint8Array => {
      const p = Uint8Array.from({ length: n }, (_, i) => (i * 7 + salt) % 251)
      p.set(new TextEncoder().encode('PACK'))
      return p
    }
    // The private era's pack under epoch 0 (its key published with Everything), a members-only one
    // under the seal-off epoch 1 (never published), and the fresh plaintext pack of the flip.
    open0 = await sealPack(await EpochKeys.import(REPO_ID, 0, K0), plain(CHUNK_PAYLOAD_MAX + 10, 1))
    members1 = await sealPack(await EpochKeys.import(REPO_ID, 1, K1), plain(CHUNK_PAYLOAD_MAX + 20, 2))
    fresh = plain(5_000, 3)
  })

  /** A Drive mock holding the three git packs' manifests (the members-only one twice: two copies) and their chunks. */
  function sdkOf(): EvoSDK {
    const packs: [Uint8Array, number][] = [
      [open0, 20],
      [members1, 30],
      [members1, 31],
      [fresh, 50],
    ]
    const manifests: Doc[] = packs.map(([bytes, height], i) => ({
      $id: `m${i}`,
      $ownerId: b58(OWNER),
      $createdAt: height * 1000,
      $createdAtBlockHeight: height,
      repoId: REPO.repoId,
      packHash: bytesToHex(sha256(bytes)),
      kind: 0,
      storage: 0,
      sizeBytes: bytes.length,
      chunkCount: Math.ceil(bytes.length / CHUNK_PAYLOAD_MAX),
    }))
    const sdk = mockSdk({ CORE: { packManifest: manifests } }, newSeen()) as unknown as { documents: { query: (q: { documentTypeName: string; where?: readonly (readonly unknown[])[] }) => Promise<Map<string, unknown>> } }
    const query = sdk.documents.query
    const byHash = new Map([open0, members1, fresh].map((b) => [bytesToHex(sha256(b)), b]))
    sdk.documents.query = async (q) => {
      if (q.documentTypeName !== 'chunk') return query(q)
      const bytes = byHash.get(bytesToHex(base58Decode(String((q.where ?? []).find((w) => w[0] === 'packHash')?.[2] ?? ''))))
      const seqs = ((q.where ?? []).find((w) => w[0] === 'seq')?.[2] as number[]) ?? []
      const out = new Map<string, unknown>()
      for (const s of seqs) {
        const from = s * CHUNK_PAYLOAD_MAX
        if (bytes !== undefined && from < bytes.length) out.set(`c${s}`, { seq: s, d0: bytesToBase64(bytes.subarray(from, Math.min(from + CHUNK_PAYLOAD_MAX, bytes.length))) })
      }
      return out
    }
    return sdk as unknown as EvoSDK
  }

  it('leaves out the packs a reader with the published keys skips, every copy, and counts them', async () => {
    const keys = await published(configs, [encodeBundle([epochKey(0, K0)], '')])
    expect(await skippedGitPacks(sdkOf(), { ...REPO, published: keys })).toEqual({
      platform: members1.length * 2,
      external: 0,
      membersOnly: 1,
      otherFormat: 0,
    })
    // Without the published keys the epoch-0 pack is skipped too.
    expect(await skippedGitPacks(sdkOf(), REPO)).toMatchObject({ platform: open0.length + members1.length * 2, membersOnly: 2 })
  })

  it("the About card's size is what a reader can clone, and says what it leaves out", async () => {
    const keys = await published(configs, [encodeBundle([epochKey(0, K0)], '')])
    const totals = await readAboutTotals(sdkOf(), { ...REPO, published: keys }, 'devnet')
    expect(totals.gitPacks).toEqual({ platform: open0.length + fresh.length, external: 0, notShown: { membersOnly: 1, otherFormat: 0 } })
    expect(repoSizeOf(totals.gitPacks!)?.tooltip).toMatch(/superseded, except 1 members-only pack from before this repo was public\.$/)
  })

  it('reads nothing more for a repo never made public', async () => {
    const plain: RepoRef = { ...REPO, repoId: b58(id(0x13)) }
    expect(await skippedGitPacks(sdkOf(), plain)).toBeNull()
  })
})

describe("a repository made public with Code only browses by its index (p5b)", () => {
  let configs: PlainDocument[]
  beforeEach(async () => {
    clearChunkCache()
    invalidateSessionCache('')
    configs = await timeline()
    recordConversion(REPO, configs)
  })

  const oid = (n: number): string => n.toString(16).padStart(40, '0')
  const oidBytes = (n: number): Uint8Array => Uint8Array.from((oid(n).match(/../g) ?? []).map((b) => parseInt(b, 16)))
  /** A fragment over `packRef`: one row per object. */
  const fragment = (packRef: number, oids: readonly number[]): Uint8Array =>
    serializeLocator(oids.map((n) => ({ oidHex: oid(n), packRef, offset: 12 + n, length: 10, deltaDepth: 0 })))

  /**
   * The private era's git pack and its fragment, both sealed under epoch 0, then the plaintext
   * pack of the published refs and (`indexed`) its fragment at packRef 1, as the make-public code
   * step writes them; `extra` adds a plaintext pack pushed later and never indexed.
   */
  async function sdkOf({ indexed = true, extra = false } = {}): Promise<EvoSDK> {
    const k0 = await EpochKeys.import(REPO_ID, 0, K0)
    const plainPack = (salt: number): Uint8Array => {
      const p = Uint8Array.from({ length: 600 }, (_, i) => (i * 7 + salt) % 251)
      p.set(new TextEncoder().encode('PACK'))
      return p
    }
    const era = await sealPack(k0, plainPack(1))
    const eraIndex = await sealPack(k0, fragment(0, [0x11, 0x12, 0x13]))
    const fresh = plainPack(2)
    const freshIndex = fragment(1, [0x21, 0x22])
    const later = plainPack(3)
    const artifacts: [Uint8Array, number, number, number][] = [
      [era, 0, 3, 20],
      [eraIndex, 1, 3, 21],
      [fresh, 0, 2, 50],
      ...(indexed ? ([[freshIndex, 1, 2, 51]] as [Uint8Array, number, number, number][]) : []),
      ...(extra ? ([[later, 0, 1, 60]] as [Uint8Array, number, number, number][]) : []),
    ]
    const manifests: Doc[] = artifacts.map(([bytes, kind, objectCount, height], i) => ({
      $id: `m${i}`,
      $ownerId: b58(OWNER),
      $createdAt: height * 1000,
      $createdAtBlockHeight: height,
      repoId: REPO.repoId,
      packHash: bytesToHex(sha256(bytes)),
      kind,
      objectCount,
      storage: 0,
      sizeBytes: bytes.length,
      chunkCount: 1,
    }))
    const sdk = mockSdk({ CORE: { packManifest: manifests } }, newSeen()) as unknown as { documents: { query: (q: { documentTypeName: string; where?: readonly (readonly unknown[])[] }) => Promise<Map<string, unknown>> } }
    const query = sdk.documents.query
    const byHash = new Map(artifacts.map(([b]) => [bytesToHex(sha256(b)), b]))
    sdk.documents.query = async (q) => {
      if (q.documentTypeName !== 'chunk') return query(q)
      const bytes = byHash.get(bytesToHex(base58Decode(String((q.where ?? []).find((w) => w[0] === 'packHash')?.[2] ?? ''))))
      return bytes === undefined ? new Map() : new Map([['c0', { seq: 0, d0: bytesToBase64(bytes) }]])
    }
    return sdk as unknown as EvoSDK
  }

  it('sets the sealed fragment aside and leaves the sealed pack unindexed, not the whole index unreadable', async () => {
    const state = await loadBrowseContext(await sdkOf(), REPO)
    expect(state).toMatchObject({ kind: 'ready' })
    if (state.kind !== 'ready') return
    expect(state.context.locator.lookup(oidBytes(0x22))).toMatchObject({ packRef: 1 })
    expect(state.context.locator.lookup(oidBytes(0x11))).toBeNull()
  })

  it('with the published keys (Everything) reads the sealed fragment too', async () => {
    const keys = await published(configs, [encodeBundle([epochKey(0, K0)], '')])
    const state = await loadBrowseContext(await sdkOf(), { ...REPO, published: keys })
    expect(state).toMatchObject({ kind: 'ready' })
    if (state.kind !== 'ready') return
    expect(state.context.locator.lookup(oidBytes(0x11))).toMatchObject({ packRef: 0 })
    expect(state.context.locator.lookup(oidBytes(0x22))).toMatchObject({ packRef: 1 })
  })

  it('a readable pack no fragment indexes still sends the repo to the fallback clone', async () => {
    expect(await loadBrowseContext(await sdkOf({ indexed: false }), REPO)).toMatchObject({ kind: 'unindexed', reason: 'no-index' })
    expect(await loadBrowseContext(await sdkOf({ extra: true }), REPO)).toMatchObject({ kind: 'unindexed', reason: 'index-behind' })
  })
})
