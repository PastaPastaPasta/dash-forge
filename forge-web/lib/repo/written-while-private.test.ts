/**
 * "Public · written while private" (DESIGN §4.10, §10; forge-core `WhilePrivate`): in a
 * repository made public, a document written while it was private and sealed under an epoch whose
 * key the owner published ("Everything") reads as public for everyone, members included; one that
 * opens only with a member's own key ("Code only", or an epoch nobody published) stays
 * members-only, marked as written while private. Documents written since are never marked.
 */

import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { ENTRY_EPOCH_KEY, EpochKeys, encodeBundle, sealDoc, sealMembersDoc, type PrivateDoc, type PrivateDocType } from '../private'
import type { Membership } from '../rules/v2'
import { bytesToBase64, type PlainDocument } from '../sdk'
import type { RepoRef } from './contract'
import { AUDIENCE_FIELD, WRITTEN_WHILE_PRIVATE, admittedAudience, laneGate, publicInEffect, publicationMarks, viewAudience, writtenWhilePrivate } from './private-content'
import { loadPrivateSession, type PrivateSession, type SessionSource } from './private-session'

const id = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const b58 = (u: Uint8Array): string => base58Encode(u)
const REPO_ID = id(0x11)
const OWNER = id(0x21)
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const REPO: RepoRef = { forge: FORGE, repoId: b58(REPO_ID), ownerId: b58(OWNER), name: 'opened', visibility: 'public' }
const K0 = Uint8Array.from({ length: 32 }, (_, i) => i)
const K1 = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i)
const K2 = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i)
const NOBODY = b58(new Uint8Array(32))

let seq = 0
const docId = (): string => b58(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? ++seq : 0x70)))

/** A sealed v0x01 document of the private era, stamped `vis: "private"`. */
async function sealedDoc(type: PrivateDocType, keys: EpochKeys, bind: Partial<PrivateDoc>, fields: Parameters<typeof sealDoc>[2], extra: PlainDocument, height: number, anchor = false): Promise<PlainDocument> {
  const enc = await sealDoc(keys, { type, ownerId: OWNER, epoch: keys.epoch, ...bind }, fields, { anchor })
  return { $id: docId(), $ownerId: b58(OWNER), $createdAt: height * 1000, $createdAtBlockHeight: height, repoId: b58(REPO_ID), epoch: keys.epoch, enc: bytesToBase64(enc), vis: 'private', ...extra }
}

/** Epochs 0, 1 and 2 anchored while private (each chaining to the one before), then the plaintext config of the flip. */
async function timeline(): Promise<PlainDocument[]> {
  const k0 = await EpochKeys.import(REPO_ID, 0, K0)
  const k1 = await EpochKeys.import(REPO_ID, 1, K1)
  const k2 = await EpochKeys.import(REPO_ID, 2, K2)
  return [
    await sealedDoc('config', k0, {}, { defaultBranch: 'main' }, {}, 10, true),
    await sealedDoc('config', k1, {}, { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) }, {}, 20, true),
    await sealedDoc('config', k2, {}, { defaultBranch: 'main', prevEpoch: 1, prevEpochKey: new Uint8Array(K1) }, {}, 30, true),
    { $id: docId(), $ownerId: b58(OWNER), $createdAt: 40_000, $createdAtBlockHeight: 40, repoId: b58(REPO_ID), defaultBranch: 'main', vis: 'public' },
  ]
}

const MEMBERS: Membership[] = [{ identity: b58(OWNER), role: 'maintainer', createdAt: 1 }]
const epochKey = (epoch: number, key: Uint8Array) => ({ kind: ENTRY_EPOCH_KEY, target: REPO_ID, revision: epoch, key })

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

describe('what the owner published reaches', () => {
  it('every epoch the published keys open, chains included; nothing for a reader of a repo with none', async () => {
    // epoch 2 is the seal-off epoch: epoch 1 is published, and its anchor carries epoch 0's key
    const s = await published(await timeline(), [encodeBundle([epochKey(1, K1)], 'made public')])
    expect([...s.publishedAll].sort()).toEqual([0, 1])
    expect([...s.publishedEpochs].sort()).toEqual([0, 1])
    const none = await published(await timeline(), [])
    expect(none.publishedAll.size).toBe(0)
  })
})

describe('a document written while the repo was private', () => {
  it('opened through a key the owner published: public for everyone, marked written while private', async () => {
    const s = await published(await timeline(), [encodeBundle([epochKey(1, K1)], '')])
    const k0 = await EpochKeys.import(REPO_ID, 0, K0)
    const comment = await sealedDoc('comment', k0, { targetId: id(0x33) }, { body: 'from the private era' }, { targetId: b58(id(0x33)) }, 15)
    const a = await s.gate.admit('comment', comment)
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(a.doc['body']).toBe('from the private era')
    expect(a.doc[WRITTEN_WHILE_PRIVATE]).toBe(true)
    expect(a.doc[AUDIENCE_FIELD]).toBeUndefined()
    expect(admittedAudience(a.doc)).toBe('public')
    expect(viewAudience(a.doc)).toEqual({})
    expect(publicationMarks(a.doc)).toEqual({ writtenWhilePrivate: true })
  })

  it("a member's gate: published epochs read as public, epochs only their own keys open stay members-only", async () => {
    // A member holds epochs 0 and 1 by their own keys; the owner published epoch 0 alone.
    const s = await published(await timeline(), [encodeBundle([epochKey(1, K1)], '')])
    const k0 = await EpochKeys.import(REPO_ID, 0, K0)
    const k1 = await EpochKeys.import(REPO_ID, 1, K1)
    const old0 = await sealedDoc('comment', k0, { targetId: id(0x33) }, { body: 'epoch 0' }, { targetId: b58(id(0x33)) }, 15)
    const old1 = await sealedDoc('comment', k1, { targetId: id(0x33) }, { body: 'epoch 1' }, { targetId: b58(id(0x33)) }, 25)
    const gate = laneGate(REPO, s.ctx, { converted: true, publishedAll: new Set([0]) })
    const a0 = await gate.admit('comment', old0)
    const a1 = await gate.admit('comment', old1)
    expect(a0.ok && [a0.doc[WRITTEN_WHILE_PRIVATE], admittedAudience(a0.doc)]).toEqual([true, 'public'])
    expect(a1.ok && [a1.doc[WRITTEN_WHILE_PRIVATE], admittedAudience(a1.doc)]).toEqual([true, 'members'])
    // "Code only": nothing published, every one of them members-only for members
    const codeOnly = laneGate(REPO, s.ctx, { converted: true })
    const c0 = await codeOnly.admit('comment', old0)
    expect(c0.ok && [writtenWhilePrivate(c0.doc), viewAudience(c0.doc)]).toEqual([true, { audience: 'members' }])
    expect(c0.ok && publicationMarks(c0.doc)).toEqual({ writtenWhilePrivate: true })
  })

  it('members-only content written since the conversion is never marked, whatever was published', async () => {
    const s = await published(await timeline(), [encodeBundle([epochKey(1, K1)], '')])
    const k0 = await EpochKeys.import(REPO_ID, 0, K0)
    // a v0x03 members-only comment stamped public (as one written after the flip is), under a published epoch number
    const enc = await sealMembersDoc(k0, { type: 'comment', vis: 'public', ownerId: OWNER, epoch: 0, targetId: id(0x33) }, { body: 'since' })
    const since: PlainDocument = { $id: docId(), $ownerId: b58(OWNER), $createdAt: 50_000, $createdAtBlockHeight: 50, repoId: b58(REPO_ID), targetId: b58(id(0x33)), epoch: 0, enc, vis: 'public' }
    const a = await laneGate(REPO, s.ctx, { converted: true, publishedAll: new Set([0]) }).admit('comment', since)
    expect(a.ok && [a.doc[WRITTEN_WHILE_PRIVATE], admittedAudience(a.doc)]).toEqual([undefined, 'members'])
  })

  it('publicInEffect: members-only content under a published epoch only, never a letter', () => {
    const doc = { epoch: 0, enc: Uint8Array.from([0x01, 1, 2]) }
    expect(publicInEffect(doc, new Set([0]))).toBe(true)
    expect(publicInEffect(doc, new Set([1]))).toBe(false)
    expect(publicInEffect(doc, undefined)).toBe(false)
    expect(publicInEffect({ ...doc, enc: Uint8Array.from([0x04, 1, 2]) }, new Set([0]))).toBe(false)
    expect(publicInEffect({ enc: Uint8Array.from([0x01, 1]) }, new Set([0]))).toBe(false)
  })
})
