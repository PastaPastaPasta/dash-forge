import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { participantKeys, seedFromMnemonic } from './derive'
import { envelopeId, sealEnvelope, type Envelope } from './envelope'
import { FMT_DEFLATE, FMT_JSON, PART_BYTES, encodeMessage, memberIdentities, mergeLogs, openShare, reassemble, sealShare, signMemberProof, verifyMemberProof, type MemberRow, type MessageRow } from './platform'
import { rosterFields, rosterFromDoc, rosterMismatch, type Roster } from './roster'
import { hex, unhex } from './util'

const V = JSON.parse(readFileSync(resolve(__dirname, '../../../forge-contracts/fixtures/org/dti-2of3.json'), 'utf8')) as {
  room: string
  cid: string
  members: { mnemonic: string; passphrase: string; authPub: string }[]
  keys: Record<string, { keyId: number; groupPublicKey: string; publicShares: Record<string, string> }>
}

const ORG = base58Encode(new Uint8Array(32).fill(3))
const OWNER = base58Encode(new Uint8Array(32).fill(5))
const seeds = V.members.map((m) => seedFromMnemonic(m.mnemonic, m.passphrase))
const keys = seeds.map(participantKeys)

let clock = 0
const rows = (envelope: Envelope, ownerId = OWNER): MessageRow[] => encodeMessage(envelope).map((p, i) => ({ ...p, id: `${envelopeId(envelope).slice(0, 8)}${i}`, ownerId, createdAt: ++clock }))

describe('orgMessage parts', () => {
  const small = sealEnvelope(keys[0]!, V.room, 'reject', { proposalId: 'a'.repeat(64), reason: 'no' })
  const large = sealEnvelope(keys[0]!, V.room, 'proposal', { blob: Array.from({ length: 12_000 }, (_, i) => ((i * 2654435761) >>> 0).toString(16)).join('') })

  it('carries a small envelope in one part and a large one in several, and reads both back', () => {
    const one = rows(small)
    expect(one).toHaveLength(1)
    expect([FMT_JSON, FMT_DEFLATE]).toContain(one[0]!.fmt)
    const many = rows(large)
    expect(many.length).toBeGreaterThan(1)
    expect(many.every((r) => r.body.length <= PART_BYTES && r.parts === many.length)).toBe(true)
    expect(reassemble([...many].reverse(), V.room).map((c) => c.envelope)).toEqual([large])
    expect(reassemble(one, V.room).map((c) => c.envelope)).toEqual([small])
  })

  it('drops a message with a part missing, a part changed, another room, or another owner holding a part', () => {
    const many = rows(large)
    expect(reassemble(many.slice(1), V.room)).toEqual([])
    const changed = many.map((r, i) => (i === 0 ? { ...r, body: Uint8Array.from(r.body, (b, j) => (j === 0 ? b ^ 1 : b)) } : r))
    expect(reassemble(changed, V.room)).toEqual([])
    expect(reassemble(many, 't_ffffffffffffffffffffffffffffffff')).toEqual([])
    expect(reassemble(many.map((r, i) => (i === 1 ? { ...r, ownerId: ORG } : r)), V.room)).toEqual([])
  })

  it('reads only canonical JSON of the four request types, signed by its sender', () => {
    const hello = sealEnvelope(keys[0]!, V.room, 'hello', { name: 'p1', transportPub: keys[0]!.transportPub })
    expect(reassemble(rows(hello), V.room)).toEqual([])
    const forged = { ...small, body: { ...small.body, reason: 'yes' } }
    expect(reassemble(rows(forged as Envelope), V.room)).toEqual([])
    const text = new TextEncoder().encode(` ${JSON.stringify(small)}`)
    const digest = new Uint8Array(32)
    crypto.getRandomValues(digest)
    expect(reassemble([{ id: 'x', ownerId: OWNER, createdAt: 1, digest, part: 0, parts: 1, fmt: FMT_JSON, body: text }], V.room)).toEqual([])
  })

  it('merges member logs: one copy per envelope, ordered by when Platform first carried it', () => {
    const a = sealEnvelope(keys[0]!, V.room, 'reject', { proposalId: 'b'.repeat(64), reason: '' })
    const b = sealEnvelope(keys[1]!, V.room, 'reject', { proposalId: 'b'.repeat(64), reason: '' })
    const merged = mergeLogs([[{ envelope: b, createdAt: 5 }, { envelope: a, createdAt: 9 }], [{ envelope: a, createdAt: 2 }]], envelopeId)
    expect(merged.envelopes).toEqual([a, b])
    expect(merged.carriedAt.get(envelopeId(a))).toBe(new Date(2).toISOString())
  })
})

describe('orgMember', () => {
  it('binds one Forge identity to one member key', () => {
    const proof = signMemberProof(keys[0]!.authSecret, 'testnet', ORG, OWNER)
    expect(verifyMemberProof(unhex(keys[0]!.authPub), proof, 'testnet', ORG, OWNER)).toBe(true)
    expect(verifyMemberProof(unhex(keys[0]!.authPub), proof, 'testnet', ORG, ORG)).toBe(false)
    expect(verifyMemberProof(unhex(keys[0]!.authPub), proof, 'mainnet', ORG, OWNER)).toBe(false)
    expect(verifyMemberProof(unhex(keys[1]!.authPub), proof, 'testnet', ORG, OWNER)).toBe(false)
  })

  it('reads at most four identities per member key, earliest first, with a valid proof', () => {
    const member = (n: number, k = 0, good = true): MemberRow => {
      const ownerId = base58Encode(new Uint8Array(32).fill(100 + n))
      return { id: `m${n}`, ownerId, createdAt: n, org: ORG, room: V.room, authPub: unhex(keys[k]!.authPub), proof: good ? signMemberProof(keys[k]!.authSecret, 'testnet', ORG, ownerId) : new Uint8Array(64) }
    }
    const got = memberIdentities([member(6), member(2), member(1, 0, false), member(3), member(4), member(5), member(7, 1)], 'testnet', ORG, [keys[0]!.authPub, keys[1]!.authPub])
    expect(got.map((r) => r.id)).toEqual(['m2', 'm3', 'm4', 'm5', 'm7'])
    expect(memberIdentities([member(1, 2)], 'testnet', ORG, [keys[0]!.authPub])).toEqual([])
  })
})

describe('orgShare', () => {
  it('only the phrase opens the sealed share, for this network, organization and ceremony', () => {
    const share = 0x1234567890abcdefn << 64n
    const sealed = sealShare(seeds[0]!, 'testnet', ORG, V.cid, share)
    expect(sealed.length).toBe(72)
    expect(openShare(seeds[0]!, 'testnet', ORG, V.cid, sealed)).toBe(share)
    expect(openShare(seeds[1]!, 'testnet', ORG, V.cid, sealed)).toBeNull()
    expect(openShare(seeds[0]!, 'mainnet', ORG, V.cid, sealed)).toBeNull()
    expect(openShare(seeds[0]!, 'testnet', ORG, 'f'.repeat(64), sealed)).toBeNull()
  })
})

describe('org roster', () => {
  const high = V.keys['high']!
  const roster: Roster = {
    source: 'ceremony',
    orgId: ORG,
    room: V.room,
    relay: 'https://multisig.dashhq.org',
    cid: V.cid,
    keyId: high.keyId,
    slot: 'high',
    groupKey: high.groupPublicKey,
    threshold: 2,
    members: V.members.map((m) => m.authPub),
    pubShares: V.members.map((_, i) => high.publicShares[String(i + 1)]!),
    label: 'Acme',
    names: ['p1', 'p2', 'p3'],
  }

  it('round-trips through the org document', () => {
    const fields = rosterFields(roster)
    expect(fields.members.length).toBe(96)
    expect(fields.pubShares.length).toBe(144)
    const back = rosterFromDoc(ORG, fields)!
    expect({ ...back, source: 'ceremony', label: 'Acme', names: roster.names }).toEqual(roster)
    expect(rosterFromDoc(ORG, { ...fields, threshold: 4 })).toBeNull()
    expect(rosterFromDoc(ORG, { ...fields, pubShares: fields.pubShares.slice(48) })).toBeNull()
  })

  it('an org write must match the ceremony exactly', () => {
    const fields = rosterFields(roster)
    expect(rosterMismatch(roster, { ...fields })).toBeNull()
    expect(rosterMismatch(roster, { ...fields, threshold: 3 })).toMatch(/threshold/)
    const swapped = Uint8Array.from([...fields.members.slice(32, 64), ...fields.members.slice(0, 32), ...fields.members.slice(64)])
    expect(rosterMismatch(roster, { ...fields, members: swapped })).toMatch(/members/)
    expect(rosterMismatch(roster, { ...fields, groupKey: unhex(hex(fields.groupKey).replace(/^../, '00')) })).toMatch(/group key/)
  })
})
