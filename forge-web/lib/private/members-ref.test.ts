/**
 * Unit tests for what the `oid_blind` / `sealed_ref` / `sealed_patch` vectors cannot cover: the
 * production (fresh-salt, hedged-nonce) seals of members-only ref updates, PRs and head updates,
 * the writer's refusals, and that a {@link BlindMap} never trusts a blind that did not check.
 */

import { describe, expect, it } from 'vitest'

import { sealMembersHeadUpdate, sealMembersPatch } from '../repo/members-writes'
import { BlindMap, blind, check, headOf, plaintextOf } from './blind'
import { bytesToHex } from './bytes'
import { openContent, sealDoc, sealMembersDoc, type OpenContext, type PrivateDoc, type StoredPrivateDoc } from './doc'
import { IdSet } from './ids'
import { EpochKeys } from './keys'
import { openMembersRef, sealMembersRef, sealedRefProps, type RefUpdateIn, type SealedRefUpdate } from './members-ref'
import { MalformedError, encodeTlv, parseMembersTlv, parseTlv } from './tlv'

const REPO_ID = new Uint8Array(32).fill(0x11)
const OWNER = new Uint8Array(32).fill(0x22)
const K0 = Uint8Array.from({ length: 32 }, (_, i) => i)
const A = new Uint8Array(20).fill(1)
const B = new Uint8Array(20).fill(2)
const SALT = new Uint8Array(32).fill(7)
const TARGET = new Uint8Array(32).fill(0x4e)

const keysFor = () => EpochKeys.import(REPO_ID, 0, K0)

async function ctx(): Promise<OpenContext> {
  return {
    keys: new Map([[0, await keysFor()]]),
    anchors: new Map([[0, { id: new Uint8Array(32).fill(0xc0), height: 10, statedHeight: 10 }]]),
    members: new IdSet(),
  }
}

function stored(s: SealedRefUpdate): StoredPrivateDoc {
  return {
    type: s.type,
    vis: 'public',
    ownerId: OWNER,
    epoch: s.epoch,
    refNameHash: s.refNameHash,
    newOid: s.newOid,
    prevOid: s.prevOid,
    force: s.force,
    createdAtBlockHeight: 50,
    enc: s.enc,
  }
}

const UPDATE: RefUpdateIn = { type: 'refUpdate', name: 'refs/heads/sec/fix', newOid: B, prevOid: A, force: false }

describe('members-only ref updates: production seals', () => {
  it('blind both OIDs under a fresh salt, open to the real values, and never repeat a blind', async () => {
    const keys = await keysFor()
    const a = await sealMembersRef(keys, OWNER, UPDATE)
    const b = await sealMembersRef(keys, OWNER, UPDATE)
    // nothing real in plaintext
    expect(bytesToHex(a.newOid)).not.toBe(bytesToHex(B))
    expect(bytesToHex(a.prevOid as Uint8Array)).not.toBe(bytesToHex(A))
    // two seals of one update share no salt and no blind: the public cannot link them
    expect(bytesToHex(a.salt)).not.toBe(bytesToHex(b.salt))
    expect(bytesToHex(a.newOid)).not.toBe(bytesToHex(b.newOid))
    expect(bytesToHex(a.prevOid as Uint8Array)).not.toBe(bytesToHex(b.prevOid as Uint8Array))
    expect(bytesToHex(a.enc.subarray(1, 13))).not.toBe(bytesToHex(b.enc.subarray(1, 13)))
    // the blinds are the salt's own
    expect(bytesToHex(a.newOid)).toBe(bytesToHex((await blind(a.salt, B)) as Uint8Array))
    for (const s of [a, b]) {
      expect(await openMembersRef(stored(s), await ctx())).toEqual({
        status: 'readable',
        ref: { name: UPDATE.name, newOid: B, prevOid: A, alerts: [] },
      })
    }
    expect(sealedRefProps(a)).toMatchObject({ vis: 'public', epoch: 0, force: false, newOid: a.newOid, prevOid: a.prevOid })
  })

  it('keep a create and a delete public: no prevOid, and an all-zero newOid', async () => {
    const keys = await keysFor()
    const create = await sealMembersRef(keys, OWNER, { ...UPDATE, prevOid: undefined })
    expect(create.prevOid).toBeUndefined()
    expect(sealedRefProps(create)).not.toHaveProperty('prevOid')
    const del = await sealMembersRef(keys, OWNER, { ...UPDATE, newOid: new Uint8Array(20) })
    expect(bytesToHex(del.newOid)).toBe('00'.repeat(20))
    expect(await openMembersRef(stored(del), await ctx())).toEqual({
      status: 'readable',
      ref: { name: UPDATE.name, newOid: new Uint8Array(20), prevOid: A, alerts: [] },
    })
  })

  it('refuse what no reader takes', async () => {
    const keys = await keysFor()
    const refused = (input: Partial<RefUpdateIn>) => expect(sealMembersRef(keys, OWNER, { ...UPDATE, ...input })).rejects.toBeInstanceOf(MalformedError)
    await refused({ prevOid: new Uint8Array(32).fill(1) })
    await refused({ newOid: new Uint8Array(20), prevOid: undefined })
    await refused({ newOid: new Uint8Array(20), prevOid: new Uint8Array(20) })
    await refused({ newOid: new Uint8Array(21).fill(1), prevOid: undefined })
    await refused({ type: 'patch' as RefUpdateIn['type'] })
  })

  it('a reader alerts on a blind the writer lied about, and keeps the real values', async () => {
    const keys = await keysFor()
    const s = await sealMembersRef(keys, OWNER, UPDATE)
    // the AD binds the plaintext blinds, so a forged one fails GCM: forge a whole document instead
    const lie = (await blind(new Uint8Array(32).fill(9), B)) as Uint8Array
    const doc: PrivateDoc = { type: 'refUpdate', vis: 'public', ownerId: OWNER, epoch: 0, refNameHash: s.refNameHash, newOid: lie, prevOid: s.prevOid, force: false }
    const enc = await sealMembersDoc(keys, doc, { refName: UPDATE.name, newOid: B, prevOid: A, oidSalt: s.salt })
    expect(await openMembersRef({ ...doc, enc, createdAtBlockHeight: 50 }, await ctx())).toEqual({
      status: 'readable',
      ref: { name: UPDATE.name, newOid: B, prevOid: A, alerts: [{ field: 'newOid', kind: 'mismatch' }] },
    })
  })
})

describe('the blind tags stay reserved outside a members-only envelope', () => {
  it('a private (v0x01) seal refuses them; the members parser takes them only where they belong', async () => {
    const keys = await keysFor()
    const fields = { refName: 'refs/heads/x', newOid: A, oidSalt: SALT }
    const doc: PrivateDoc = { type: 'refUpdate', ownerId: OWNER, epoch: 0, refNameHash: new Uint8Array(32), newOid: A, force: false }
    await expect(sealDoc(keys, doc, fields)).rejects.toBeInstanceOf(MalformedError)
    const tlv = encodeTlv(fields)
    expect(() => parseTlv(tlv, { type: 'refUpdate', epoch: 0 })).toThrow(MalformedError)
    expect(parseMembersTlv(tlv, 'refUpdate')).toEqual(fields)
    expect(() => parseMembersTlv(encodeTlv({ title: 't', headOid: A, oidSalt: SALT }), 'issue')).toThrow(MalformedError)
    expect(() => parseMembersTlv(encodeTlv({ refName: 'refs/heads/x', headOid: A, oidSalt: SALT }), 'refUpdate')).toThrow(MalformedError)
    // the salt is there exactly when something is blinded
    expect(() => parseMembersTlv(encodeTlv({ refName: 'refs/heads/x', newOid: A }), 'refUpdate')).toThrow(MalformedError)
    expect(() => parseMembersTlv(encodeTlv({ refName: 'refs/heads/x', oidSalt: SALT }), 'refUpdate')).toThrow(MalformedError)
    // a head update carries a head, a value, or both
    expect(parseMembersTlv(encodeTlv({ headOid: A, oidSalt: SALT }), 'event')).toEqual({ headOid: A, oidSalt: SALT })
    expect(() => parseMembersTlv(new Uint8Array(0), 'event')).toThrow(MalformedError)
  })
})

describe('a BlindMap never trusts a blind that did not check', () => {
  it('learns verified pairs only', async () => {
    const m = new BlindMap()
    const ok = (await blind(SALT, A)) as Uint8Array
    expect(await m.learn('headOid', ok, A, SALT)).toBeNull()
    expect(m.realOf(bytesToHex(ok).toUpperCase())).toBe(bytesToHex(A))
    // the blind of another salt, of another commit, of another width: alerts, never learned
    const otherSalt = (await blind(new Uint8Array(32).fill(8), A)) as Uint8Array
    expect(await m.learn('headOid', otherSalt, A, SALT)).toEqual({ field: 'headOid', kind: 'mismatch' })
    expect(m.realOf(bytesToHex(otherSalt))).toBeUndefined()
    const otherCommit = (await blind(SALT, B)) as Uint8Array
    expect(await m.learn('headOid', otherCommit, A, SALT)).toEqual({ field: 'headOid', kind: 'mismatch' })
    expect(m.realOf(bytesToHex(otherCommit))).toBeUndefined()
    const wide = (await blind(SALT, new Uint8Array(32).fill(1))) as Uint8Array
    expect(await m.learn('headOid', wide, A, SALT)).toEqual({ field: 'headOid', kind: 'width' })
    expect(m.realOf(bytesToHex(wide))).toBeUndefined()
    // a blind with no real value or salt beside it is malformed: no alert, nothing learned
    expect(await m.learn('headOid', ok, undefined, SALT)).toBeNull()
    expect(await m.learn('headOid', ok, A, undefined)).toBeNull()
    expect(m.size).toBe(1)
    expect(m.realOrPlain('abcd')).toBe('abcd')
  })

  it('a null OID is never blinded', async () => {
    expect(bytesToHex((await plaintextOf(SALT, new Uint8Array(20))) as Uint8Array)).toBe('00'.repeat(20))
    expect(await check(new Uint8Array(20))).toBe('null')
    expect(await blind(SALT, new Uint8Array(21))).toBeNull()
    expect(await headOf(A)).toEqual({ kind: 'plain' })
    expect(await headOf(new Uint8Array(20), A, SALT)).toBeNull()
  })
})

describe('members-only PRs and head updates: production seals', () => {
  it('copy the source branch blind (rule C) and seal the real head beside it', async () => {
    const keys = await keysFor()
    // the members-only source branch's ref update introduced the blind of B
    const ref = await sealMembersRef(keys, OWNER, UPDATE)
    const head = { real: B, salt: ref.salt }
    const patch = await sealMembersPatch(
      keys,
      OWNER,
      { number: 3, title: 'Fix', baseRefName: 'refs/heads/main', sourceRefName: UPDATE.name, headOid: ref.newOid },
      { basePublic: true, sourcePublic: false, head },
    )
    expect(patch).not.toHaveProperty('title')
    expect(bytesToHex(patch['headOid'] as Uint8Array)).toBe(bytesToHex(ref.newOid))
    const doc: StoredPrivateDoc = {
      type: 'patch',
      vis: 'public',
      ownerId: OWNER,
      epoch: 0,
      number: 3,
      baseRefNameHash: patch['baseRefNameHash'] as Uint8Array,
      sourceRefNameHash: patch['sourceRefNameHash'] as Uint8Array,
      createdAtBlockHeight: 50,
      enc: patch['enc'] as Uint8Array,
    }
    const opened = await openContent(doc, await ctx())
    if (opened.status !== 'readable') throw new Error(`not readable: ${JSON.stringify(opened)}`)
    expect(opened.fields.title).toBe('Fix')
    expect(await headOf(ref.newOid, opened.fields.headOid, opened.fields.oidSalt)).toEqual({ kind: 'real', real: B, salt: ref.salt })

    const update = await sealMembersHeadUpdate(keys, OWNER, { targetId: TARGET, kind: 16, oid: ref.newOid }, head)
    const event = await openContent({ type: 'event', vis: 'public', ownerId: OWNER, epoch: 0, targetId: TARGET, enc: update['enc'] as Uint8Array }, await ctx())
    expect(event).toEqual({ status: 'readable', fields: { headOid: B, oidSalt: ref.salt } })
  })

  it('refuse a head that is not the blind it claims, or a blinded head of a public source', async () => {
    const keys = await keysFor()
    const head = { real: B, salt: SALT }
    const blindB = (await blind(SALT, B)) as Uint8Array
    const props = { number: 3, title: 'Fix', baseRefName: 'refs/heads/main', sourceRefName: 'refs/heads/sec/fix' }
    // the real head in plaintext
    await expect(sealMembersPatch(keys, OWNER, { ...props, headOid: B }, { basePublic: true, sourcePublic: false, head })).rejects.toBeInstanceOf(MalformedError)
    // no plaintext head at all
    await expect(sealMembersPatch(keys, OWNER, props, { basePublic: true, sourcePublic: false, head })).rejects.toBeInstanceOf(MalformedError)
    await expect(sealMembersPatch(keys, OWNER, { ...props, headOid: blindB }, { basePublic: true, sourcePublic: true, head })).rejects.toBeInstanceOf(MalformedError)
    // a members-only source without its blind: the plaintext headOid would be the real commit
    await expect(sealMembersPatch(keys, OWNER, { ...props, headOid: B }, { basePublic: true, sourcePublic: false })).rejects.toBeInstanceOf(MalformedError)
    await expect(sealMembersPatch(keys, OWNER, { ...props, headOid: blindB }, { basePublic: false, sourcePublic: false })).rejects.toBeInstanceOf(MalformedError)
    await expect(sealMembersHeadUpdate(keys, OWNER, { targetId: TARGET, kind: 16, oid: A }, head)).rejects.toBeInstanceOf(MalformedError)
    // a head update is a kind-16 event, nothing else
    await expect(sealMembersHeadUpdate(keys, OWNER, { targetId: TARGET, kind: 1, oid: blindB }, head)).rejects.toBeInstanceOf(MalformedError)
    // a public source's head is the plain commit: nothing sealed beside it
    const plain = await sealMembersPatch(keys, OWNER, { ...props, headOid: A }, { basePublic: true, sourcePublic: true })
    expect(bytesToHex(plain['headOid'] as Uint8Array)).toBe(bytesToHex(A))
  })
})
