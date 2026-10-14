/**
 * {@link membersUpdatesOf} beyond the shared `sealed_ref` union vectors: production seals, the
 * unreadable count, and that an opened members-only document never puts a real OID into a
 * plaintext field ({@link asPlaintext}, rule C).
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { BranchKey, BranchKeys, BranchRing, EpochKeys, IdSet, bytesToHex, foldBranchLetters, openContent, sealBranchRef, sealMembersRef, type OpenContext, type SealedRefUpdate } from '../private'
import { bytesToBase64, type PlainDocument } from '../sdk'
import { membersUpdatesOf } from './members-refs'
import { asPlaintext } from './private-content'

const REPO_ID = new Uint8Array(32).fill(0x11)
const OWNER = new Uint8Array(32).fill(0x22)
const A = new Uint8Array(20).fill(1)
const B = new Uint8Array(20).fill(2)
const NAME = 'refs/heads/sec/fix'

const id = (n: number) => base58Encode(new Uint8Array(32).fill(n))
const b64 = (b: Uint8Array) => bytesToBase64(b)

function sealedRow(n: number, createdAt: number, s: SealedRefUpdate): PlainDocument {
  return {
    $id: id(n),
    $ownerId: base58Encode(OWNER),
    $createdAt: createdAt,
    $createdAtBlockHeight: 100,
    vis: 'public',
    epoch: s.epoch,
    refNameHash: b64(s.refNameHash),
    newOid: b64(s.newOid),
    ...(s.prevOid !== undefined ? { prevOid: b64(s.prevOid) } : {}),
    force: s.force,
    enc: b64(s.enc),
  }
}

const CTX = async (k0: EpochKeys): Promise<OpenContext> => ({
  keys: new Map([[0, k0]]),
  anchors: new Map([[0, { id: new Uint8Array(32).fill(0xc0), height: 10, statedHeight: 10 }]]),
  members: new IdSet(),
})

function publicRow(n: number, createdAt: number, newOid: Uint8Array, prevOid?: Uint8Array): PlainDocument {
  return {
    $id: id(n),
    $ownerId: base58Encode(OWNER),
    $createdAt: createdAt,
    refName: NAME,
    refNameHash: b64(sha256(new TextEncoder().encode(NAME))),
    newOid: b64(newOid),
    ...(prevOid !== undefined ? { prevOid: b64(prevOid) } : {}),
    force: false,
  }
}

const update = (n: number, createdAt: number, newOid: Uint8Array, prevOid = new Uint8Array(0)) => ({
  id: id(n),
  refNameHash: bytesToHex(sha256(new TextEncoder().encode(NAME))),
  refName: NAME,
  prevOid: bytesToHex(prevOid),
  newOid: bytesToHex(newOid),
  force: false,
  protected: false,
  author: base58Encode(OWNER),
  createdAt,
})

describe('membersUpdatesOf', () => {
  it('folds a deleted public branch and its members-only successor on real values, and counts what it cannot open', async () => {
    const k0 = await EpochKeys.import(REPO_ID, 0, new Uint8Array(32).fill(3))
    const k1 = await EpochKeys.import(REPO_ID, 1, new Uint8Array(32).fill(4))
    const ctx = await CTX(k0)
    const members = await sealMembersRef(k0, OWNER, { type: 'refUpdate', name: NAME, newOid: B, force: false })
    // under an epoch this reader holds no key for: counted, never folded
    const later = await sealMembersRef(k1, OWNER, { type: 'refUpdate', name: NAME, newOid: A, prevOid: B, force: true })
    const rows = {
      refUpdate: [
        sealedRow(3, 1000, members),
        publicRow(1, 900, A),
        publicRow(2, 901, new Uint8Array(20), A),
        // a commitment that does not open; a plaintext refName beside enc; a later enc version; no
        // newOid at all: members-only, never folded, counted
        { ...sealedRow(5, 1003, members), enc: b64(new Uint8Array([3, ...new Uint8Array(70)])) },
        { ...sealedRow(6, 1004, members), refName: NAME },
        { ...sealedRow(7, 1005, members), enc: b64(new Uint8Array([6, ...members.enc.subarray(1)])) },
        { ...sealedRow(8, 1006, members), newOid: undefined },
        // a converted repository's private-era row: not members-only content, skipped uncounted
        { ...sealedRow(9, 1007, members), vis: 'private' },
      ],
      protectedRefUpdate: [sealedRow(4, 1001, later)],
    }
    const got = await membersUpdatesOf(rows, (d) => openContent(d, ctx))
    expect(got.unreadable).toBe(5)
    expect(got.alerts).toEqual([])
    expect([...got.byName.keys()]).toEqual([NAME])
    expect(got.byName.get(NAME)).toEqual([update(1, 900, A), update(2, 901, new Uint8Array(20), A), update(3, 1000, B)])
  })

  it('lets a live public name win (D29): its members-only updates are left out, with an alert each', async () => {
    const k0 = await EpochKeys.import(REPO_ID, 0, new Uint8Array(32).fill(3))
    const ctx = await CTX(k0)
    const members = await sealMembersRef(k0, OWNER, { type: 'refUpdate', name: NAME, newOid: B, force: false })
    const other = await sealMembersRef(k0, OWNER, { type: 'refUpdate', name: 'refs/heads/sec/other', newOid: B, force: false })
    // a bigint epoch (how the SDK may return an integer) is an epoch too
    const rows = { refUpdate: [publicRow(1, 900, A), { ...sealedRow(3, 1000, members), epoch: 0n }, sealedRow(2, 950, members), sealedRow(4, 960, other)], protectedRefUpdate: [] }
    const got = await membersUpdatesOf(rows, (d) => openContent(d, ctx))
    expect(got.unreadable).toBe(0)
    expect([...got.byName.keys()]).toEqual([NAME, 'refs/heads/sec/other'])
    expect(got.byName.get(NAME)).toEqual([update(1, 900, A)])
    expect(got.alerts).toEqual([
      { id: id(2), kind: 'publicName' },
      { id: id(3), kind: 'publicName' },
    ])
  })
})

describe('membersUpdatesOf with narrower branches (enc v0x06)', () => {
  const SEC = 'refs/heads/sec/embargo'
  const letter = { name: SEC, keys: [BranchKey.fromBytes(new Uint8Array(32).fill(9))], audience: { group: 'maintainers' as const, also: [] }, to: [base58Encode(OWNER)] }
  const ringOf = () => BranchRing.create(REPO_ID, foldBranchLetters([{ id: 'l', height: 1, sender: 'owner', letter }], () => true), () => [OWNER])

  it('opens them with the ring, folds them apart from the members key, and marks them', async () => {
    const k0 = await EpochKeys.import(REPO_ID, 0, new Uint8Array(32).fill(3))
    const ctx = await CTX(k0)
    const ring = await ringOf()
    const keys = ring.writeKeys(SEC) as BranchKeys
    const narrow = await sealBranchRef(keys, OWNER, { type: 'refUpdate', name: SEC, newOid: A, force: false })
    const members = await sealMembersRef(k0, OWNER, { type: 'refUpdate', name: NAME, newOid: B, force: false })
    const rows = { refUpdate: [sealedRow(1, 900, narrow), sealedRow(2, 901, members)], protectedRefUpdate: [] }
    const got = await membersUpdatesOf(rows, (d) => openContent(d, ctx), [], undefined, (d) => ring.open(d, d.enc))
    expect(got.unreadable).toBe(0)
    expect([...got.byName.keys()]).toEqual([SEC, NAME])
    expect(got.byName.get(SEC)?.map((u) => [u.id, u.refName, u.newOid])).toEqual([[id(1), SEC, bytesToHex(A)]])
    expect([...got.narrower]).toEqual([id(1)])
    // a narrower branch's commits never count as the members key's
    expect([...got.openedNewOids]).toEqual([bytesToHex(B)])
    expect([...got.openedNarrower]).toEqual([[bytesToHex(A), SEC]])
    expect(got.unreadableNarrower.size).toBe(0)
    // the members key alone opens none of it: counted, once per branch
    const alone = await membersUpdatesOf(rows, (d) => openContent(d, ctx))
    expect(alone.unreadable).toBe(1)
    expect([...alone.byName.keys()]).toEqual([NAME])
    expect([...alone.unreadableNarrower]).toEqual([bytesToHex(narrow.refNameHash)])
    expect(alone.narrower.size).toBe(0)
  })

  it('counts each branch it holds no key for once, and none whose newest update deletes it', async () => {
    const k0 = await EpochKeys.import(REPO_ID, 0, new Uint8Array(32).fill(3))
    const ctx = await CTX(k0)
    const keys = (await ringOf()).writeKeys(SEC) as BranchKeys
    const other = await BranchKeys.derive(REPO_ID, 0, BranchKey.fromBytes(new Uint8Array(32).fill(4)))
    const a1 = await sealBranchRef(keys, OWNER, { type: 'refUpdate', name: SEC, newOid: A, force: false })
    const a2 = await sealBranchRef(keys, OWNER, { type: 'refUpdate', name: SEC, newOid: B, prevOid: A, force: false })
    const made = await sealBranchRef(other, OWNER, { type: 'refUpdate', name: 'refs/heads/gone', newOid: A, force: false })
    const gone = await sealBranchRef(other, OWNER, { type: 'refUpdate', name: 'refs/heads/gone', newOid: new Uint8Array(20), prevOid: A, force: false })
    // rows out of order: the newest of each name hash decides
    const rows = { refUpdate: [sealedRow(4, 1003, gone), sealedRow(1, 1000, a1), sealedRow(3, 1002, made), sealedRow(2, 1001, a2)], protectedRefUpdate: [] }
    const got = await membersUpdatesOf(rows, (d) => openContent(d, ctx))
    expect(got.unreadable).toBe(4)
    expect([...got.unreadableNarrower]).toEqual([bytesToHex(a1.refNameHash)])
  })

  it('a name with a narrower update keeps only those: its members-key updates are left out, with an alert each', async () => {
    const k0 = await EpochKeys.import(REPO_ID, 0, new Uint8Array(32).fill(3))
    const ctx = await CTX(k0)
    const ring = await ringOf()
    const narrow = await sealBranchRef(ring.writeKeys(SEC) as BranchKeys, OWNER, { type: 'refUpdate', name: SEC, newOid: A, force: false })
    // a member outside the branch's audience moves it with the members key
    const moved = await sealMembersRef(k0, OWNER, { type: 'refUpdate', name: SEC, newOid: B, prevOid: A, force: true })
    // a protected update is sealed as one: the AD binds the document type
    const movedProtected = await sealMembersRef(k0, OWNER, { type: 'protectedRefUpdate', name: SEC, newOid: B, prevOid: A, force: true })
    const rows = { refUpdate: [sealedRow(3, 902, moved), sealedRow(1, 900, narrow)], protectedRefUpdate: [sealedRow(2, 901, movedProtected)] }
    const got = await membersUpdatesOf(rows, (d) => openContent(d, ctx), [], undefined, (d) => ring.open(d, d.enc))
    expect(got.byName.get(SEC)?.map((u) => u.id)).toEqual([id(1)])
    expect(got.alerts).toEqual([
      { id: id(3), kind: 'narrowerName' },
      { id: id(2), kind: 'narrowerName' },
    ])
    // what the members key decrypts is still its own
    expect([...got.openedNewOids]).toEqual([bytesToHex(B)])
    // without the branch key, the members-key updates fold as before
    const alone = await membersUpdatesOf(rows, (d) => openContent(d, ctx))
    expect(alone.byName.get(SEC)?.map((u) => u.id)).toEqual([id(2), id(3)])
    expect(alone.alerts).toEqual([])
  })

  it('a public name wins over a narrower update too (D29)', async () => {
    const ring = await ringOf()
    const keys = ring.writeKeys(SEC) as BranchKeys
    const narrow = await sealBranchRef(keys, OWNER, { type: 'refUpdate', name: SEC, newOid: B, force: false })
    const pub = { ...publicRow(1, 900, A), refName: SEC, refNameHash: b64(sha256(new TextEncoder().encode(SEC))) }
    const rows = { refUpdate: [pub, sealedRow(2, 901, narrow)], protectedRefUpdate: [] }
    const k0 = await EpochKeys.import(REPO_ID, 0, new Uint8Array(32).fill(3))
    const got = await membersUpdatesOf(rows, async (d) => openContent(d, await CTX(k0)), [], undefined, (d) => ring.open(d, d.enc))
    expect(got.alerts).toEqual([{ id: id(2), kind: 'publicName' }])
    expect(got.narrower.size).toBe(0)
    expect(got.byName.get(SEC)?.map((u) => u.id)).toEqual([id(1)])
  })
})

describe('asPlaintext keeps the blinds as written', () => {
  it('never copies a real OID or its salt into a plaintext field', () => {
    const doc: PlainDocument = { headOid: 'blind', oid: 'blind', newOid: 'blind', enc: 'x', epoch: 0 }
    const out = asPlaintext(doc, { title: 'Fix', headOid: A, newOid: B, prevOid: A, oidSalt: new Uint8Array(32) })
    expect(out).toEqual({ headOid: 'blind', oid: 'blind', newOid: 'blind', title: 'Fix', $sealedEpoch: 0 })
  })
})
