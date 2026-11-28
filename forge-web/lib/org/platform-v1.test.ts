import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { participantKeys } from './derive'
import { envelopeId, type Envelope } from './envelope'
import { MAX_PAYLOAD, mergeLogs, memberIdentities, openShare, reassemble, sealShare, signMemberProof, storedPayload, verifyMemberProof, type MemberRow, type MessageRow } from './platform'
import { declinedOut, findRequest, goneCreate, supersededWrite, groupRequests, landed, proposalDone, refusalReasons, refusedText, declinedText, requestStatus, type OrgRequest, type ProposalFacts } from './requests'
import { rosterCeremony, rosterFields, rosterFromDoc } from './roster'
import { reduce, type Proposal } from './state'
import { hex, unhex } from './util'

type Doc = Record<string, string | number>
interface Part {
  readonly action: 'create' | 'replace' | 'delete'
  readonly shares: number
  readonly claim: boolean
  readonly nonceSpent: boolean
  readonly doc: 'absent' | 'present' | 'same' | 'different' | 'later'
  readonly takenByOther: boolean
}

const F = JSON.parse(readFileSync(resolve(__dirname, '../../../forge-contracts/fixtures/org/platform-v1.json'), 'utf8')) as {
  network: string
  orgId: string
  room: string
  cid: string
  threshold: number
  size: number
  limits: { maxPart: number; maxParts: number; maxPayload: number; maxIdentitiesPerKey: number }
  members: { index: number; authPub: string; seed: string; ownerId: string; proof: string; share: string; sealedShare: string }[]
  sealedShares: { name: string; seed: string; network: string; org: string; sealed: string; share: string | null }[]
  memberDocs: Doc[]
  boundIdentities: Record<string, string[]>
  roster: { room: string; relay: string; cid: string; keyId: number; groupKey: string; threshold: number; members: string; pubShares: string }
  messages: { name: string; envelope: Envelope; fmt: number; digest: string; parts: string[]; id: string; writerFmt: number }[]
  reassembly: { name: string; docs: Doc[]; accepted: string[] }[]
  merge: {
    boundOwners: Record<string, string[]>
    docs: Doc[]
    order: string[]
    at: Record<string, string>
    expected: Record<string, { proposal: string; status: string; shares?: number[]; rejections?: string[] }>
  }
  requestIds: { envelopes: Envelope[]; requests: { id: string; proposer: string; proposals: string[]; forge: boolean }[]; resolve: { query: string; id: string | null }[] }
  status: { threshold: number; size: number; cases: { name: string; parts: Part[]; expect: { parts: string[]; status: string; text?: string }; declined?: number; problems?: string[] }[] }
}

const memberRow = (d: Doc): MemberRow => ({
  id: String(d['$id']),
  ownerId: String(d['$ownerId']),
  createdAt: Number(d['$createdAt']),
  org: String(d['org']),
  room: String(d['room']),
  authPub: unhex(String(d['authPub'])),
  proof: unhex(String(d['proof'])),
})

const messageRow = (d: Doc): MessageRow => ({
  id: String(d['$id']),
  ownerId: String(d['$ownerId']),
  createdAt: Number(d['$createdAt']),
  digest: unhex(String(d['digest'])),
  part: Number(d['part']),
  parts: Number(d['parts']),
  fmt: Number(d['fmt']),
  body: unhex(String(d['body'])),
})

const roster = rosterFromDoc(F.orgId, {
  room: F.roster.room,
  relay: F.roster.relay,
  cid: unhex(F.roster.cid),
  keyId: F.roster.keyId,
  groupKey: unhex(F.roster.groupKey),
  threshold: F.roster.threshold,
  members: unhex(F.roster.members),
  pubShares: unhex(F.roster.pubShares),
})!

describe('platform-v1.json (shared with forge-core::org)', () => {
  it('agrees on the limits', () => {
    expect(F.limits).toEqual({ maxPart: 5120, maxParts: 16, maxPayload: MAX_PAYLOAD, maxIdentitiesPerKey: 4 })
  })

  it('binds each member identity with the same proof, and seals and opens the same share', () => {
    for (const m of F.members) {
      const seed = unhex(m.seed)
      const keys = participantKeys(seed)
      expect(keys.authPub).toBe(m.authPub)
      expect(hex(signMemberProof(keys.authSecret, F.network, F.orgId, m.ownerId))).toBe(m.proof)
      expect(verifyMemberProof(unhex(m.authPub), unhex(m.proof), F.network, F.orgId, m.ownerId)).toBe(true)
      const sealed = unhex(m.sealedShare)
      expect(hex(sealShare(seed, F.network, F.orgId, F.cid, BigInt(`0x${m.share}`), sealed.slice(0, 24)))).toBe(m.sealedShare)
      expect(openShare(seed, F.network, F.orgId, F.cid, sealed)).toBe(BigInt(`0x${m.share}`))
    }
  })

  it.each(F.sealedShares.map((c) => [c.name, c] as const))('sealed share: %s', (_name, c) => {
    const got = openShare(unhex(c.seed), c.network, c.org, F.cid, unhex(c.sealed))
    expect(got === null ? null : got.toString(16).padStart(64, '0')).toBe(c.share)
  })

  it('reads the same member identities', () => {
    const rows = memberIdentities(F.memberDocs.map(memberRow), F.network, F.orgId, roster.members)
    const bound: Record<string, string[]> = {}
    for (const r of rows) (bound[hex(r.authPub)] ??= []).push(r.ownerId)
    expect(bound).toEqual(F.boundIdentities)
  })

  it('reads the roster document', () => {
    expect(roster.threshold).toBe(F.threshold)
    expect(roster.members).toHaveLength(F.size)
    expect(roster.cid).toBe(F.cid)
    expect(hex(rosterFields(roster).members)).toBe(F.roster.members)
  })

  it.each(F.messages.map((m) => [m.name, m] as const))('message: %s', (_name, m) => {
    expect(envelopeId(m.envelope)).toBe(m.id)
    expect(storedPayload(m.envelope).fmt).toBe(m.writerFmt)
    const rows = m.parts.map((body, part): MessageRow => ({ id: `p${part}`, ownerId: 'o', createdAt: part, digest: unhex(m.digest), part, parts: m.parts.length, fmt: m.fmt, body: unhex(body) }))
    expect(reassemble(rows, F.room).map((c) => c.envelope)).toEqual([m.envelope])
  })

  it.each(F.reassembly.map((c) => [c.name, c] as const))('reassembly: %s', (_name, c) => {
    expect(reassemble(c.docs.map(messageRow), F.room).map((x) => envelopeId(x.envelope))).toEqual(c.accepted)
  })

  it('merges member logs: only an identity bound to the sender counts, ordered and timed by Platform', () => {
    const owners = new Map(Object.entries(F.merge.boundOwners).flatMap(([authPub, list]) => list.map((o) => [o, authPub] as const)))
    const logs = [...owners].map(([owner, authPub]) =>
      reassemble(
        F.merge.docs.filter((d) => d['$ownerId'] === owner).map(messageRow),
        F.room,
        authPub,
      ),
    )
    const { envelopes, carriedAt } = mergeLogs(logs, envelopeId)
    expect(envelopes.map(envelopeId)).toEqual(F.merge.order)
    expect(Object.fromEntries(carriedAt)).toEqual(F.merge.at)
    const state = reduce(envelopes, { room: F.room, ceremonies: [rosterCeremony(roster)], carriedAt })
    for (const want of Object.values(F.merge.expected)) {
      const p = state.proposals[want.proposal]!
      expect(p.status).toBe(want.status)
      if (want.shares) expect(Object.keys(p.requirements[0]!.shares).map(Number)).toEqual(want.shares)
      if (want.rejections) expect(Object.keys(p.rejections)).toEqual(want.rejections)
    }
  })

  it('gives every request the same id, and resolves the same queries', () => {
    const state = reduce(F.requestIds.envelopes, { room: F.room, ceremonies: [rosterCeremony(roster)] })
    const requests = groupRequests(state, F.cid)
    const got = requests.map((r) => ({ id: r.id, proposer: r.from, proposals: r.proposals.map((p) => p.id), forge: r.forge }))
    expect(got.sort((a, b) => a.id.localeCompare(b.id))).toEqual([...F.requestIds.requests].sort((a, b) => a.id.localeCompare(b.id)))
    const views = requests.map((request) => ({ request }))
    for (const q of F.requestIds.resolve) expect(findRequest(views, q.query)?.request.id ?? null).toBe(q.id)
  })

  it.each(F.status.cases.map((c) => [c.name, c] as const))('status: %s', (_name, c) => {
    const decliners = Array.from({ length: c.declined ?? 0 }, (_, i) => roster.members[F.status.size - 1 - i] as string)
    const proposals: Proposal[] = c.parts.map((part, i) => ({
      id: `p${i}`,
      from: roster.members[0] as string,
      at: '2026-11-28T12:00:00.000Z',
      body: { network: F.network, intent: { type: 'document' }, unsigned: '00', signable: '00', requirements: [{ cid: F.cid, slot: 'high' }] },
      approvals: {},
      rejections: Object.fromEntries(decliners.map((k) => [k, { id: k, at: '', reason: '' }])),
      broadcasts: [],
      requirements: [],
      status: part.shares >= F.status.threshold ? (part.claim ? 'executed' : 'ready') : 'collecting',
      executedBy: null,
    }))
    const request: OrgRequest = { id: 'r', title: 't', forge: true, proposals, from: roster.members[0] as string, at: '', malformed: (c.problems ?? []).includes('its parts are missing, repeated, or from different members') }
    const want = { revision: 2n, fields: { a: 1 } }
    const stored = (doc: Part['doc']) => (doc === 'absent' ? null : doc === 'later' ? { revision: 3n, fields: { a: 2 } } : doc === 'different' ? { revision: 2n, fields: { a: 2 } } : { revision: 2n, fields: { a: 1 } })
    const facts = new Map<string, ProposalFacts>(
      c.parts.map((part, i) => {
        const isLanded = landed(part.action, stored(part.doc), want, part.nonceSpent, part.claim)
        const superseded = !isLanded && supersededWrite(part.action, stored(part.doc), want.revision, part.nonceSpent, part.claim)
        const problems = (c.problems ?? []).filter((x) => x !== 'its parts are missing, repeated, or from different members')
        return [`p${i}`, { reviewProblems: i === 0 ? problems : [], nonce: BigInt(i), contractId: 'c', spent: part.nonceSpent || part.takenByOther, onChain: isLanded && !part.takenByOther, gone: goneCreate(part.action, part.claim, part.nonceSpent, isLanded, part.takenByOther), superseded }]
      }),
    )
    const partState = (i: number): string => {
      const f = facts.get(`p${i}`)!
      if (f.gone) return 'gone'
      if (proposalDone(f)) return 'done'
      if (f.spent || f.superseded) return 'expired'
      return proposals[i]!.status === 'collecting' ? 'collecting' : 'ready'
    }
    expect(c.parts.map((_, i) => partState(i))).toEqual(c.expect.parts)
    const status = requestStatus(request, (id) => facts.get(id), declinedOut(request, new Set(roster.members), F.status.threshold))
    expect(status).toBe(c.expect.status)
    if (c.expect.text?.startsWith('Declined')) expect(declinedText(F.status.threshold, F.status.size)).toBe(c.expect.text)
    if (c.expect.text?.startsWith('Forge')) expect(refusedText(refusalReasons(request, (id) => facts.get(id)))).toBe(c.expect.text)
    if (c.expect.text?.startsWith('Done')) expect(c.parts.some((_, i) => facts.get(`p${i}`)!.gone)).toBe(true)
  })
})
