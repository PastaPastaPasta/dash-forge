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
import { PackSkippedError, clearChunkCache, loadArtifactBytesProgress } from '../view/browse-source'
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
    const later = { ...comment, enc: bytesToBase64(Uint8Array.from([0x05, ...new Uint8Array(60)])) }
    expect(await s.gate.admit('comment', later)).toMatchObject({ ok: false, reason: 'unknownVersion' })
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
