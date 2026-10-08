/**
 * Unit tests for what the `mixed_doc_*` and `named_envelope*` vectors cannot cover: the
 * production (randomized) members-only and specific-people seals, and the writer's refusals.
 */

import { getPublicKey } from '@noble/secp256k1'
import { describe, expect, it } from 'vitest'

import { MIN_MEMBERS_ENC, letterFraming, openContent, sealDoc, sealMembersDoc, type OpenContext, type PrivateDoc } from './doc'
import { IdSet } from './ids'
import { EpochKeys } from './keys'
import { ArtifactError, openLetter, openLetterArtifact, sealLetter, sealLetterArtifact, type LetterRecipient, type OwnerKey } from './named'
import { MalformedError } from './tlv'

const REPO_ID = new Uint8Array(32).fill(0x11)
const OWNER = new Uint8Array(32).fill(0x22)
const K0 = Uint8Array.from({ length: 32 }, (_, i) => i)
const secret = (b: number) => new Uint8Array(32).fill(b)
const id = (b: number) => new Uint8Array(32).fill(0xa0 + b)
const party = (b: number): LetterRecipient => ({ identityId: id(b), publicKey: getPublicKey(secret(b), true) })

describe('members-only content (enc v0x03)', () => {
  const doc: PrivateDoc = { type: 'comment', vis: 'public', ownerId: OWNER, epoch: 0, targetId: new Uint8Array(32).fill(0x33) }

  it('seals with a fresh nonce, pads to 64 bytes and opens in either kind of repository', async () => {
    const keys = await EpochKeys.import(REPO_ID, 0, K0)
    const ctx: OpenContext = { keys: new Map([[0, keys]]), anchors: new Map([[0, { id: new Uint8Array(32), height: 1, statedHeight: 1 }]]), members: new IdSet([]) }
    const a = await sealMembersDoc(keys, doc, { body: 'members only' })
    const b = await sealMembersDoc(keys, doc, { body: 'members only' })
    expect(a[0]).toBe(0x03)
    expect(a.subarray(1, 13)).not.toEqual(b.subarray(1, 13))
    expect((a.length - MIN_MEMBERS_ENC) % 64).toBe(0)
    expect(await openContent({ ...doc, enc: a, createdAtBlockHeight: 5 }, ctx)).toEqual({ status: 'readable', fields: { body: 'members only' } })
    // the same bytes on a private document open too (DESIGN D38: readers admit v0x03 in private
    // repositories; the AD does not bind `vis`)
    expect(await openContent({ ...doc, vis: undefined, enc: a, createdAtBlockHeight: 5 }, ctx)).toEqual({ status: 'readable', fields: { body: 'members only' } })
    // a later client's envelope is members-only to this reader in either kind of repository, never malformed
    for (const v of [0x05, 0x06, 0xff]) {
      const later = Uint8Array.from(a)
      later[0] = v
      for (const vis of ['public', undefined] as const) {
        expect(await openContent({ ...doc, vis, enc: later, createdAtBlockHeight: 5 }, ctx)).toEqual({ status: 'unreadable', reason: 'unknownVersion' })
      }
    }
  })

  it('refuses a private header, a config and a v0x01 seal of a public document', async () => {
    const keys = await EpochKeys.import(REPO_ID, 0, K0)
    await expect(sealMembersDoc(keys, { ...doc, vis: undefined }, { body: 'x' })).rejects.toBeInstanceOf(MalformedError)
    await expect(sealMembersDoc(keys, { type: 'config', vis: 'public', ownerId: OWNER, epoch: 0 }, {})).rejects.toBeInstanceOf(MalformedError)
    await expect(sealDoc(keys, doc, { body: 'x' })).rejects.toBeInstanceOf(MalformedError)
  })
})

describe('specific-people letters (enc v0x04)', () => {
  const alice = party(1)
  const doc: PrivateDoc = { type: 'comment', vis: 'public', ownerId: alice.identityId, epoch: 0, targetId: new Uint8Array(32).fill(0x33) }
  const owner: OwnerKey[] = [{ id: 4, purpose: 1, keyType: 0, data: alice.publicKey }]

  it('every recipient, and only they, read a production letter', async () => {
    const recipients = [alice, party(2), party(3)]
    const enc = await sealLetter(REPO_ID, secret(1), 4, doc, { body: 'embargo' }, recipients)
    expect((enc.length - letterFraming(3)) % 64).toBe(0)
    for (const [i, b] of [1, 2, 3].entries()) {
      const r = await openLetter(REPO_ID, { ...doc, enc }, owner, { identityId: id(b), secrets: [secret(b)] })
      expect(r).toMatchObject({ status: 'readable', fields: { body: 'embargo' }, slot: i })
    }
    expect(await openLetter(REPO_ID, { ...doc, enc }, owner, { identityId: id(4), secrets: [secret(4)] })).toEqual({
      status: 'unreadable',
      reason: 'notARecipient',
    })
    // a letter is 'letter' for the epoch-key reader, never misread
    const ctx: OpenContext = { keys: new Map(), anchors: new Map(), members: new IdSet([]) }
    expect(await openContent({ ...doc, enc }, ctx)).toEqual({ status: 'unreadable', reason: 'letter' })
  })

  it('the sender is slot 0, ids are unique, at most 16, under epoch 0', async () => {
    const f = { body: 'x' }
    await expect(sealLetter(REPO_ID, secret(1), 4, doc, f, [alice, { identityId: id(2).subarray(0, 31), publicKey: party(2).publicKey }])).rejects.toBeInstanceOf(
      MalformedError,
    )
    await expect(sealLetter(REPO_ID, secret(1), 4, doc, f, [alice, { identityId: id(2), publicKey: new Uint8Array(65).fill(4) }])).rejects.toBeInstanceOf(
      MalformedError,
    )
    await expect(sealLetter(REPO_ID, secret(1), 4, doc, f, [party(2), alice])).rejects.toBeInstanceOf(MalformedError)
    await expect(sealLetter(REPO_ID, secret(1), 4, doc, f, [alice, alice])).rejects.toBeInstanceOf(MalformedError)
    await expect(sealLetter(REPO_ID, secret(1), 4, doc, f, [])).rejects.toBeInstanceOf(MalformedError)
    const seventeen = [alice, ...Array.from({ length: 16 }, (_, i) => party(i + 2))]
    await expect(sealLetter(REPO_ID, secret(1), 4, doc, f, seventeen)).rejects.toBeInstanceOf(MalformedError)
    await expect(sealLetter(REPO_ID, secret(1), 4, { ...doc, epoch: 1 }, f, [alice])).rejects.toBeInstanceOf(MalformedError)
  })
})

describe('artifacts under a specific-people header (DFPK 0x02)', () => {
  it('a production seal of several segments opens for each recipient, not for others', async () => {
    const alice = party(1)
    const owner: OwnerKey[] = [{ id: 4, purpose: 1, keyType: 0, data: alice.publicKey }]
    const plain = Uint8Array.from({ length: 40000 }, (_, i) => i % 251)
    const sealed = await sealLetterArtifact(REPO_ID, secret(1), 4, alice.identityId, [alice, party(2)], plain)
    expect(sealed.length).toBe(69 + 2 * 64 + 40000 + 3 * 16)
    for (const b of [1, 2]) {
      expect(await openLetterArtifact(REPO_ID, sealed, sealed.length, owner, { identityId: id(b), secrets: [secret(b)] })).toEqual(plain)
    }
    await expect(openLetterArtifact(REPO_ID, sealed, sealed.length, owner, { identityId: id(3), secrets: [secret(3)] })).rejects.toEqual(
      new ArtifactError('notARecipient'),
    )
  })
})
