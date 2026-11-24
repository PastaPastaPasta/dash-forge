import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { combineShares, signShare, verify } from './bls'
import { ceremonyId, publicShareOf } from './ceremony'
import { participantKeys, seedFromMnemonic } from './derive'
import { envelopeId, sealEnvelope, verifyEnvelope, type Envelope } from './envelope'
import { approve, approveBody, combine, recoverShares } from './participant'
import { reduce } from './state'
import { canonical, unhex } from './util'

interface VectorMember {
  mnemonic: string
  passphrase: string
  name: string
  index: number
  authPub: string
  transportPub: string
  publicShares: Record<string, string>
}

const V = JSON.parse(readFileSync(resolve(__dirname, '../../../forge-contracts/fixtures/org/dti-2of3.json'), 'utf8')) as {
  room: string
  cid: string
  threshold: number
  members: VectorMember[]
  keys: Record<string, { keyId: number; purpose: string; securityLevel: string; groupPublicKey: string; publicShares: Record<string, string> }>
  transcript: string
  canonical: [unknown, string][]
  ceremonyMessages: Envelope[]
  proposals: { one: { id: string; envelope: Envelope; signable: string }; two: { id: string; envelope: Envelope } }
  approvals: { m1: Envelope; m3: Envelope; m2OnTwo: Envelope }
  reject: Envelope
  broadcast: Envelope
  expected: {
    afterOneApproval: { status: string; shares: number[] }
    afterTwo: { status: string; shares: number[] }
    two: { status: string; rejections: string[] }
    combined: string
    afterBroadcast: string
    envelopeIds: string[]
  }
}

const base = [...V.ceremonyMessages, V.proposals.one.envelope, V.proposals.two.envelope]
const ONE = V.proposals.one.id
const TWO = V.proposals.two.id
const SHARE_KEY = `${V.cid}/high`
const people = V.members.map((m) => {
  const seed = seedFromMnemonic(m.mnemonic, m.passphrase)
  return { ...m, seed, keys: participantKeys(seed) }
})
const baseState = reduce(base, { room: V.room })

describe('dti/1 vector', () => {
  it('canonical JSON matches dti', () => {
    for (const [value, text] of V.canonical) expect(canonical(value)).toBe(text)
    expect(() => canonical({ x: 1.5 })).toThrow()
    expect(() => canonical({ x: 2 ** 53 })).toThrow()
    expect(canonical({ a: undefined, b: 1n })).toBe('{"b":"1"}')
  })

  it('envelope ids and signatures', () => {
    expect(V.ceremonyMessages.slice(0, 4).map(envelopeId)).toEqual(V.expected.envelopeIds)
    for (const e of [...base, V.approvals.m1, V.approvals.m3, V.approvals.m2OnTwo, V.reject, V.broadcast]) expect(verifyEnvelope(e)).toBe(true)
    expect(envelopeId(V.proposals.one.envelope)).toBe(ONE)
    expect(envelopeId(V.proposals.two.envelope)).toBe(TWO)
  })

  it('derives each member key from the phrase', () => {
    for (const p of people) {
      expect(p.keys.authPub).toBe(p.authPub)
      expect(p.keys.transportPub).toBe(p.transportPub)
    }
  })

  it('a re-sealed envelope reproduces the signature byte for byte', () => {
    const p = people[0]!
    const e = V.proposals.one.envelope
    expect(sealEnvelope(p.keys, e.room, e.type, e.body, e.at)).toEqual(e)
  })

  it('ceremony result: cid, group keys, public shares, transcript', () => {
    const c = baseState.ceremonies[V.cid]!
    expect(c.status).toBe('complete')
    expect(ceremonyId(c.config)).toBe(V.cid)
    expect(c.result!.transcript).toBe(V.transcript)
    for (const [slot, k] of Object.entries(V.keys)) {
      const got = c.result!.keys[slot]!
      expect(got.groupPublicKey).toBe(k.groupPublicKey)
      expect(got.keyId).toBe(k.keyId)
      expect(got.purpose).toBe(k.purpose)
      expect(got.securityLevel).toBe(k.securityLevel)
      expect(Object.fromEntries(Object.entries(got.publicShares).map(([i, v]) => [String(i), v]))).toEqual(k.publicShares)
    }
  })

  it('ceremony order does not matter', () => {
    const shuffled = [...base].reverse()
    expect(reduce(shuffled).ceremonies[V.cid]!.result!.transcript).toBe(V.transcript)
  })

  it("each member's recovered share matches its public share", () => {
    for (const p of people) {
      const r = recoverShares(p.seed, p.keys, baseState, V.cid)
      expect(r.index).toBe(p.index)
      for (const [slot, share] of Object.entries(r.shares)) expect(publicShareOf(share)).toBe(p.publicShares[slot])
    }
  })

  it('reproduces the share signatures in approvals byte for byte', () => {
    const [p1, p2, p3] = people as [(typeof people)[0], (typeof people)[0], (typeof people)[0]]
    const a1 = approve(p1.seed, p1.keys, V.room, baseState, ONE, V.approvals.m1.at)
    expect(a1).toEqual(V.approvals.m1)
    expect(approve(p3.seed, p3.keys, V.room, baseState, ONE, V.approvals.m3.at)).toEqual(V.approvals.m3)
    expect(approve(p2.seed, p2.keys, V.room, baseState, TWO, V.approvals.m2OnTwo.at)).toEqual(V.approvals.m2OnTwo)
  })

  it('proposal states and the combined signature', () => {
    const one = reduce([...base, V.approvals.m1]).proposals[ONE]!
    expect(one.status).toBe(V.expected.afterOneApproval.status)
    expect(Object.keys(one.requirements[0]!.shares).map(Number)).toEqual(V.expected.afterOneApproval.shares)

    const all = [...base, V.approvals.m1, V.approvals.m3, V.approvals.m2OnTwo, V.reject]
    const state = reduce(all)
    expect(state.proposals[ONE]!.status).toBe(V.expected.afterTwo.status)
    expect(Object.keys(state.proposals[ONE]!.requirements[0]!.shares).map(Number)).toEqual(V.expected.afterTwo.shares)
    expect(state.proposals[TWO]!.status).toBe(V.expected.two.status)
    expect(Object.keys(state.proposals[TWO]!.rejections)).toEqual(V.expected.two.rejections)

    const combined = combine(state, ONE)[SHARE_KEY]!
    expect(combined.signature).toBe(V.expected.combined)
    expect(combined.signers).toEqual([1, 3])
    expect(verify(combined.signature, unhex(V.proposals.one.signable), V.keys['high']!.groupPublicKey)).toBe(true)

    expect(reduce([...all, V.broadcast]).proposals[ONE]!.status).toBe(V.expected.afterBroadcast)
  })

  it('any two shares combine to the same signature', () => {
    const msg = unhex(V.proposals.one.signable)
    const shares = Object.fromEntries(
      people.map((p) => [p.index, signShare(recoverShares(p.seed, p.keys, baseState, V.cid).shares['high']!, msg)]),
    ) as Record<number, string>
    expect(combineShares({ 1: shares[1]!, 2: shares[2]! })).toBe(V.expected.combined)
    expect(combineShares({ 2: shares[2]!, 3: shares[3]! })).toBe(V.expected.combined)
  })
})

describe('dti/1 negatives', () => {
  it('one share cannot make a valid signature', () => {
    const msg = unhex(V.proposals.one.signable)
    const s1 = (V.approvals.m1.body['shares'] as Record<string, { share: string }>)[SHARE_KEY]!.share
    expect(verify(combineShares({ 1: s1 }), msg, V.keys['high']!.groupPublicKey)).toBe(false)
    const state = reduce([...base, V.approvals.m1])
    expect(() => combine(state, ONE)).toThrow(/collecting/)
  })

  it('a tampered share is not counted', () => {
    const p2 = people[1]!
    const wrong = sealEnvelope(p2.keys, V.room, 'approve', {
      proposalId: ONE,
      shares: { [SHARE_KEY]: { index: 2, share: signShare(12345n, unhex(V.proposals.one.signable)) } },
    })
    const state = reduce([...base, V.approvals.m1, wrong])
    const p = state.proposals[ONE]!
    expect(p.status).toBe('collecting')
    expect(p.requirements[0]!.invalidShares).toEqual([2])

    const otherIndex = sealEnvelope(p2.keys, V.room, 'approve', { proposalId: ONE, shares: approveBody(people[0]!.seed, people[0]!.keys, baseState, V.proposals.one.envelope.body as never) })
    expect(reduce([...base, V.approvals.m1, otherIndex]).proposals[ONE]!.status).toBe('collecting')
  })

  it('a tampered envelope is rejected', () => {
    const forged = { ...V.approvals.m3, body: { ...V.approvals.m3.body, proposalId: TWO } }
    expect(verifyEnvelope(forged)).toBe(false)
    const state = reduce([...base, V.approvals.m1, forged])
    expect(state.proposals[ONE]!.status).toBe('collecting')
    expect(Object.keys(state.proposals[TWO]!.approvals)).toEqual([])
    const badAt = { ...V.approvals.m3, at: '2026-11-24 19:30:32Z' }
    expect(verifyEnvelope(badAt)).toBe(false)
  })

  it('a wrong phrase recovers no share', () => {
    const seed = seedFromMnemonic('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong')
    expect(() => recoverShares(seed, participantKeys(seed), baseState, V.cid)).toThrow(/not a participant/)
    const p1 = people[0]!
    const otherSeed = seedFromMnemonic(p1.mnemonic, '')
    expect(() => recoverShares(otherSeed, { ...participantKeys(otherSeed), authPub: p1.authPub, transportPub: p1.transportPub }, baseState, V.cid)).toThrow()
  })

  it('a ceremony missing one completion is not complete', () => {
    const lastComplete = V.ceremonyMessages.findLastIndex((m) => m.type === 'dkg-complete')
    const msgs = V.ceremonyMessages.filter((_, i) => i !== lastComplete)
    expect(reduce(msgs).ceremonies[V.cid]!.status).toBe('incomplete')
  })

  it('a broadcast from a non-member does not execute', () => {
    const stranger = participantKeys(new Uint8Array(64).fill(9))
    const bc = sealEnvelope(stranger, V.room, 'broadcast', { proposalId: ONE, result: { ok: true, confirmed: true } })
    expect(reduce([...base, V.approvals.m1, V.approvals.m3, bc]).proposals[ONE]!.status).toBe('ready')
  })
})
