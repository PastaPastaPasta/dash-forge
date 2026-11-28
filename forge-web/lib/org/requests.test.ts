import { describe, expect, it } from 'vitest'

import { declaredOrgLink, orgsEnabled, parseDeclaredOrg } from './gate'
import { parseInvite, roomOnNetwork } from './invite'
import { cardState, declinedText, findRequest, groupRequests, makeNote, parseNote, refusalReasons, refusedText, requestStatus, waitingForViewer, type ProposalFacts } from './requests'
import type { Proposal, RoomState } from './state'

const CID = 'c'.repeat(64)
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

function proposal(id: string, note: string | undefined, over: Partial<Proposal> = {}): Proposal {
  return {
    id,
    from: A,
    at: `2026-11-24T00:00:0${id.length % 10}.000Z`,
    body: { network: 'testnet', intent: { type: 'document' }, unsigned: '00', signable: '01', requirements: [{ cid: CID, slot: 'high' }], ...(note !== undefined ? { note } : {}) },
    approvals: {},
    rejections: {},
    broadcasts: [],
    requirements: [{ cid: CID, slot: 'high', key: `${CID}/high`, threshold: 2, shares: { 1: 'aa' }, invalidShares: [] }],
    status: 'collecting',
    executedBy: null,
    ...over,
  }
}

const state = (ps: Proposal[]): RoomState => ({ hellos: {}, ceremonies: {}, proposals: Object.fromEntries(ps.map((p) => [p.id, p])), messageCount: ps.length })
const note = (seq: number, of: number, group = '0123456789abcdef') => makeNote({ group, seq, of, title: 'Create acme/widgets' })
const facts = (nonce: bigint, extra: Partial<ProposalFacts> = {}): ProposalFacts => ({ reviewProblems: [], nonce, contractId: 'core', onChain: false, ...extra })

describe('notes', () => {
  it('round-trips and refuses malformed notes', () => {
    expect(parseNote(note(1, 3))).toEqual({ group: '0123456789abcdef', seq: 1, of: 3, title: 'Create acme/widgets' })
    expect(note(0, 1)).toBe('{"forge":1,"group":"0123456789abcdef","seq":0,"of":1,"title":"Create acme/widgets"}')
    expect(parseNote('{"forge":1,"group":"g1","seq":0,"of":1,"title":"x"}')).toBeNull()
    expect(parseNote('{"forge":2,"group":"0123456789abcdef","seq":0,"of":1,"title":"x"}')).toBeNull()
    expect(parseNote('{"forge":1,"group":"0123456789abcdef","seq":1,"of":1,"title":"x"}')).toBeNull()
    expect(parseNote(`{"forge":1,"group":"0123456789abcdef","seq":0,"of":1,"title":"${'x'.repeat(121)}"}`)).toBeNull()
    expect(parseNote('second')).toBeNull()
    expect(makeNote({ group: '0123456789abcdef', seq: 0, of: 1, title: 'y'.repeat(200) }).length).toBeLessThan(200)
  })
})

describe('grouping', () => {
  const G = '0123456789abcdef'
  it('groups proposals by note.group in seq order; others stand alone', () => {
    const reqs = groupRequests(state([proposal('p2', note(1, 2)), proposal('p1', note(0, 2)), proposal('solo', 'made elsewhere')]), CID)
    const forge = reqs.find((r) => r.forge)!
    expect(forge.id).toBe(`${G}-${A.slice(0, 16)}`)
    expect(forge.proposals.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(forge.malformed).toBe(false)
    const solo = reqs.find((r) => !r.forge)!
    expect(solo.id).toBe('solo')
    expect(solo.title).toBeNull()
  })

  it("every id carries its proposer's key, so a backdated reuse of a group claims nothing (§11.5)", () => {
    const reqs = groupRequests(state([proposal('p1', note(0, 1)), proposal('p2', note(0, 1), { from: B, at: '2000-01-01T00:00:00.000Z' })]), CID)
    expect(reqs).toHaveLength(2)
    expect(reqs.every((r) => !r.malformed)).toBe(true)
    expect(reqs.find((r) => r.from === A)!.id).toBe(`${G}-${A.slice(0, 16)}`)
    expect(reqs.find((r) => r.from === B)!.id).toBe(`${G}-${B.slice(0, 16)}`)
  })

  it('a bare group id resolves only when exactly one proposer used it', () => {
    const views = (ps: Proposal[]) => groupRequests(state(ps), CID).map((request) => ({ request }))
    const one = views([proposal('p1', note(0, 1))])
    expect(findRequest(one, G)?.request.from).toBe(A)
    expect(findRequest(one, `${G}-${A.slice(0, 16)}`)?.request.from).toBe(A)
    expect(findRequest(one, 'p1')).toBeNull()
    expect(findRequest(one, G.slice(0, 6))?.request.from).toBe(A)
    expect(findRequest(one, G.slice(0, 3))).toBeNull()
    const two = views([proposal('p1', note(0, 1)), proposal('p2', note(0, 1), { from: B })])
    expect(findRequest(two, G)).toBeNull()
    expect(findRequest(two, `${G}-${B.slice(0, 16)}`)?.request.from).toBe(B)
    expect(findRequest(views([proposal('solo', undefined)]), 'solo')?.request.id).toBe('solo')
  })

  it('a group with a missing part or a duplicate seq is malformed', () => {
    expect(groupRequests(state([proposal('p1', note(0, 2))]), CID)[0]!.malformed).toBe(true)
    expect(groupRequests(state([proposal('p1', note(0, 2)), proposal('p2', note(0, 2))]), CID)[0]!.malformed).toBe(true)
  })

  it('ignores proposals for another ceremony', () => {
    const other = proposal('x', note(0, 1), { body: { ...proposal('x', undefined).body, requirements: [{ cid: 'd'.repeat(64), slot: 'high' }] } })
    expect(groupRequests(state([other]), CID)).toEqual([])
  })
})

describe('request status', () => {
  const [req] = groupRequests(state([proposal('p1', note(0, 2)), proposal('p2', note(1, 2))]), CID)
  const base = { p1: facts(5n), p2: facts(6n) } as Record<string, ProposalFacts>
  const with_ = (over: (id: string) => Partial<ProposalFacts>) => (id: string) => ({ ...base[id]!, ...over(id) })
  const plain = (id: string) => base[id]

  it('collecting, ready, done, expired, invalid', () => {
    expect(requestStatus(req!, plain)).toBe('collecting')
    const ready = { ...req!, proposals: req!.proposals.map((p) => ({ ...p, status: 'ready' as const })) }
    expect(requestStatus(ready, plain)).toBe('ready')
    expect(requestStatus(req!, with_(() => ({ spent: true })))).toBe('expired')
    expect(requestStatus(req!, with_((id) => ({ onChain: id === 'p1', spent: id === 'p1' })))).toBe('collecting')
    expect(requestStatus(req!, with_((id) => ({ onChain: true, spent: true, reviewProblems: id === 'p1' ? ['it raises the fee'] : [] })))).toBe('invalid')
    expect(requestStatus(req!, with_(() => ({ onChain: true, spent: true })))).toBe('done')
    expect(requestStatus(req!, with_((id) => ({ reviewProblems: id === 'p2' ? ['bad'] : [] })))).toBe('invalid')
    expect(requestStatus(req!, with_(() => ({ nonceProblem: 'its nonce is further ahead than Platform accepts' })), true)).toBe('invalid')
    expect(requestStatus(req!, with_(() => ({ nonceUnread: true })))).toBe('collecting')
    const invalid = { ...req!, proposals: [{ ...req!.proposals[0]!, status: 'invalid' as const }, req!.proposals[1]!] }
    expect(requestStatus(invalid, plain)).toBe('invalid')
  })

  it("a member's broadcast claim alone is not done; a create gone from Platform after its claim is (§11.6)", () => {
    const claimed = { ...req!, proposals: req!.proposals.map((p) => ({ ...p, status: 'executed' as const })) }
    expect(requestStatus(claimed, plain)).toBe('ready')
    expect(requestStatus(claimed, with_(() => ({ spent: true })))).toBe('expired')
    expect(requestStatus(claimed, with_(() => ({ spent: true, gone: true })))).toBe('done')
  })

  it('invalid wins over declined, and declined over done and expired (§11.3)', () => {
    expect(requestStatus(req!, with_((id) => ({ reviewProblems: id === 'p1' ? ['bad'] : [] })), true)).toBe('invalid')
    expect(requestStatus(req!, plain, true)).toBe('declined')
    expect(requestStatus(req!, with_(() => ({ spent: true })), true)).toBe('declined')
  })

  it("says why Forge won't sign it", () => {
    expect(refusalReasons(req!, with_((id) => ({ reviewProblems: id === 'p2' ? ['the transition raises the fee'] : [] })))).toEqual(['the transition raises the fee'])
    expect(refusalReasons({ ...req!, malformed: true }, with_(() => ({ reviewProblems: ['it raises the fee'] })))).toEqual(['its parts are missing, repeated, or from different members', 'it raises the fee'])
  })
})

describe('request card', () => {
  it('one primary state per status, in the same words as dg', () => {
    expect(cardState('collecting', 1, 2, false)).toEqual({ kind: 'sign', collected: 1, needed: 2 })
    expect(cardState('collecting', 1, 2, true)).toEqual({ kind: 'signed', missing: 1 })
    expect(cardState('ready', 2, 2, true)).toEqual({ kind: 'finish' })
    expect(cardState('done', 2, 2, true)).toEqual({ kind: 'done' })
    expect(cardState('expired', 1, 2, false)).toEqual({ kind: 'expired' })
    expect(cardState('declined', 1, 2, false, [], 3)).toEqual({ kind: 'declined', needed: 2, size: 3 })
    expect(cardState('invalid', 0, 2, false, ['why'])).toEqual({ kind: 'invalid', reasons: ['why'] })
    expect(declinedText(2, 3)).toBe('Declined: too many members declined it to reach 2 of 3.')
    expect(refusedText(['the nonce was already used', 'the transition raises the fee'])).toBe("Forge won't sign this: the nonce was already used; the transition raises the fee.")
  })

  it('counts as waiting only while collecting, unsigned and not declined', () => {
    expect(waitingForViewer('collecting', false, false)).toBe(true)
    expect(waitingForViewer('collecting', true, false)).toBe(false)
    expect(waitingForViewer('collecting', false, true)).toBe(false)
    expect(waitingForViewer('ready', false, false)).toBe(false)
    expect(waitingForViewer('expired', false, false)).toBe(false)
  })
})

describe('gating and links', () => {
  it('organizations are off on mainnet only', () => {
    expect(orgsEnabled('mainnet')).toBe(false)
    expect(orgsEnabled('testnet')).toBe(true)
    expect(orgsEnabled('devnet')).toBe(true)
  })

  it('reads a declared organization from its profile link', () => {
    expect(declaredOrgLink('testnet', 2, 3)).toBe('https://multisig.dashhq.org/?network=testnet#org=2of3')
    expect(parseDeclaredOrg('https://multisig.dashhq.org/?network=testnet#org=2of3', 'testnet')).toEqual({ threshold: 2, size: 3 })
    expect(parseDeclaredOrg('https://multisig.dashhq.org/?network=mainnet#org=2of3', 'testnet')).toBeNull()
    expect(parseDeclaredOrg('https://multisig.dashhq.org/?network=testnet#org=4of3', 'testnet')).toBeNull()
    expect(parseDeclaredOrg('https://evil.example/?network=testnet#org=2of3', 'testnet')).toBeNull()
  })

  it('accepts the hosted invite link and a bare group id', () => {
    expect(parseInvite('https://multisig.dashhq.org/?network=testnet#room=t_000102030405060708090a0b0c0d0e0f&name=Acme%20Labs')).toEqual({
      room: 't_000102030405060708090a0b0c0d0e0f',
      relay: 'https://multisig.dashhq.org',
      label: 'Acme Labs',
      network: 'testnet',
    })
    expect(parseInvite('  t_000102030405060708090a0b0c0d0e0f ')).toEqual({ room: 't_000102030405060708090a0b0c0d0e0f', relay: 'https://multisig.dashhq.org', label: null, network: 'testnet' })
    expect(parseInvite('https://relay.example.org/#room=abcdefgh12')?.relay).toBe('https://relay.example.org')
    expect(parseInvite('http://multisig.dashhq.org/#room=t_000102030405060708090a0b0c0d0e0f')).toBeNull()
    expect(parseInvite('not a group')).toBeNull()
    expect(roomOnNetwork('m_000102030405060708090a0b0c0d0e0f', 'testnet')).toBe(false)
    expect(roomOnNetwork('dsakura_000102030405060708090a0b0c0d0e0f', 'devnet-sakura')).toBe(true)
  })
})
