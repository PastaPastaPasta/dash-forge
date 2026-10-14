/**
 * The production paths of `./branch-key` (the vectors pin the deterministic ones in
 * `branch-key.conformance.test.ts`): fresh salts and hedged nonces, a pack's hedged `fileId`, a
 * letter through its typed form into a ring that opens what was sealed, and no key material in any
 * `toString`, `inspect` or JSON.
 */

import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import {
  BranchKey,
  BranchKeys,
  BranchRing,
  branchKeyLetterFromTyped,
  branchKeyLetterToTyped,
  foldBranchLetters,
  nextGenerationLetter,
  openBranchPack,
  parseBranchKeyLetter,
  sealBranchPack,
  sealBranchRef,
  sniffBranchKcv,
  type Branch,
  type BranchKeyLetter,
} from './branch-key'
import { bytesToHex, utf8 } from './bytes'
import { decodeKeyLetter, encodeKeyLetter } from './key-letter'
import { realValues, type RefUpdateIn } from './members-ref'
import { PackError } from './pack'
import { MalformedError } from './tlv'

const REPO = new Uint8Array(32).fill(0x11)
const OWNER = new Uint8Array(32).fill(0x22)
const ME = base58Encode(OWNER)
const keyOf = (b: number) => BranchKey.fromBytes(new Uint8Array(32).fill(b))
const derive = (b: number, gen = 0) => BranchKeys.derive(REPO, gen, keyOf(b))
const OUTSIDER = base58Encode(new Uint8Array(32).fill(0x44))
/** The audience is the owner alone. */
const ownerOnly = (sender: string) => sender === ME
const INPUT: RefUpdateIn = { type: 'refUpdate', name: 'refs/heads/sec/x', newOid: new Uint8Array(20).fill(2), force: false }

async function packError(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    if (e instanceof PackError) return e.code
    throw e
  }
  return 'opened'
}

describe('narrower branch production seals', () => {
  it('draws a fresh salt and nonce for every ref update', async () => {
    const k = await derive(3)
    const a = await sealBranchRef(k, OWNER, INPUT)
    const b = await sealBranchRef(k, OWNER, INPUT)
    expect(bytesToHex(a.enc.subarray(5, 17))).not.toBe(bytesToHex(b.enc.subarray(5, 17)))
    expect(bytesToHex(a.newOid)).not.toBe(bytesToHex(b.newOid))
    expect(a.enc[0]).toBe(0x06)
    expect(bytesToHex(a.enc.subarray(1, 5))).toBe(bytesToHex(k.kcv4))
    expect(a.epoch).toBe(0)
    await expect(sealBranchRef(k, OWNER, { ...INPUT, name: 'refs/tags/v1' })).rejects.toBeInstanceOf(MalformedError)
  })

  it('round-trips a pack under a hedged fileId, and skips one without the key', async () => {
    const k = await derive(3)
    const plain = utf8('hello')
    const p = await sealBranchPack(k, plain)
    const q = await sealBranchPack(k, plain)
    expect(bytesToHex(p.subarray(20, 36))).not.toBe(bytesToHex(q.subarray(20, 36)))
    expect(bytesToHex(await openBranchPack(p, p.length, [await derive(4), k]))).toBe(bytesToHex(plain))
    expect(bytesToHex(sniffBranchKcv(p) as Uint8Array)).toBe(bytesToHex(k.kcv4))
    expect(await packError(openBranchPack(p, p.length, [await derive(4)]))).toBe('noKey')
    expect(await packError(openBranchPack(p, p.length + 1, [k]))).toBe('sizeMismatch')
    const other = p.slice()
    other[4] = 0x01
    expect(await packError(openBranchPack(other, other.length, [k]))).toBe('sealedPackCorrupt')
  })
})

describe('the branchKey letter and the ring', () => {
  const letter: BranchKeyLetter = { name: 'refs/heads/sec/x', keys: [keyOf(3)], audience: { group: 'maintainers', also: [] }, to: [ME] }

  it('carries a letter through its typed, canonical form', async () => {
    const t = branchKeyLetterToTyped(letter)
    const back = decodeKeyLetter(encodeKeyLetter(t))
    expect(back).not.toBeNull()
    const parsed = branchKeyLetterFromTyped(back as NonNullable<typeof back>)
    expect(typeof parsed === 'object' && parsed !== null && parsed.keys[0]?.equals(keyOf(3))).toBe(true)
    expect(parseBranchKeyLetter({ ...t.fields, type: 'branch', v: 1 })).toBeNull()
    expect(parseBranchKeyLetter({ ...t.fields, type: 'branchKey', v: 1, to: [bytesToHex(OWNER)] })).toBe('malformed')
    const { to: _to, ...noTo } = t.fields
    expect(parseBranchKeyLetter({ ...noTo, type: 'branchKey', v: 1 })).toBe('malformed')
  })

  it('opens what its write keys sealed, and nothing of another generation', async () => {
    const next = nextGenerationLetter(
      foldBranchLetters([{ id: 'a', height: 10, sender: ME, letter }], ownerOnly).branches.get(letter.name) as Branch,
      keyOf(5),
      letter.audience,
      [ME],
    )
    const fold = foldBranchLetters(
      [
        { id: 'a', height: 10, sender: ME, letter },
        { id: 'b', height: 20, sender: ME, letter: next },
      ],
      ownerOnly,
    )
    const ring = await BranchRing.create(REPO, fold, () => [OWNER])
    const w = ring.writeKeys(letter.name) as BranchKeys
    expect(w.gen).toBe(1)
    expect(ring.allKeys()).toHaveLength(2)
    expect(ring.branchOfKcv(w.kcv4)).toBe(letter.name)
    const s = await sealBranchRef(w, OWNER, INPUT)
    const doc = { type: s.type, vis: 'public' as const, ownerId: OWNER, epoch: s.epoch, refNameHash: s.refNameHash, newOid: s.newOid, force: s.force, createdAtBlockHeight: 30 }
    const opened = await ring.open(doc, s.enc)
    expect(opened.status).toBe('readable')
    if (opened.status !== 'readable') return
    expect(bytesToHex((await realValues(doc, opened.fields))?.newOid as Uint8Array)).toBe(bytesToHex(INPUT.newOid))
    expect(await ring.open({ ...doc, epoch: 0 }, s.enc)).toEqual({ status: 'unreadable', reason: 'noKey' })
    const empty = await BranchRing.create(REPO, foldBranchLetters([], ownerOnly), () => [])
    expect(await empty.open(doc, s.enc)).toEqual({ status: 'unreadable', reason: 'noKey' })
  })

  it('keeps a letter from outside the audience read-only, never to write under', async () => {
    const fork = nextGenerationLetter({ ...letter, gen: 0, issuedAt: [10], holders: [ME], letters: ['a'], readOnly: [] }, keyOf(7), letter.audience, [ME])
    const fold = foldBranchLetters(
      [
        { id: 'b', height: 20, sender: OUTSIDER, letter: fork },
        { id: 'a', height: 10, sender: ME, letter },
        { id: 'c', height: 5, sender: OUTSIDER, letter: { ...letter, name: 'refs/heads/sec/y' } },
      ],
      ownerOnly,
    )
    expect(fold.ignored).toEqual([
      { id: 'c', reason: 'sender' },
      { id: 'b', reason: 'sender' },
    ])
    expect([...fold.branches.keys()]).toEqual([letter.name])
    const b = fold.branches.get(letter.name) as Branch
    expect(b.gen).toBe(0)
    expect(b.readOnly.map((r) => r.gen)).toEqual([1])
    const ring = await BranchRing.create(REPO, fold, () => [OWNER])
    expect(ring.writeKeys(letter.name)?.gen).toBe(0)
    expect(ring.allKeys()).toHaveLength(2)
    const ro = await derive(7, 1)
    expect(ring.branchOfKcv(ro.kcv4)).toBe(letter.name)
  })

  it('never shows key material', async () => {
    const k = keyOf(0xab)
    const keys = await derive(0xab)
    const ring = await BranchRing.create(REPO, foldBranchLetters([{ id: 'a', height: 1, sender: ME, letter: { ...letter, keys: [k] } }], ownerOnly), () => [])
    for (const s of [String(k), inspect(k), JSON.stringify(k), String(keys), inspect(keys), inspect(letter, { depth: 9 }), inspect(ring, { depth: 9 })]) {
      expect(s).not.toMatch(/abab|171,\s*171/)
    }
    expect(String(k)).toBe('BranchKey(<redacted>)')
    expect(inspect(keys)).toContain(`kcv: ${bytesToHex(keys.kcv4)}`)
  })
})
