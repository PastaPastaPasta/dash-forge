import { describe, expect, it } from 'vitest'

import { declaredOrgLink, orgsEnabled, parseDeclaredOrg } from './gate'
import { parseInvite, roomOnNetwork } from './invite'
import { cardState, groupRequests, makeNote, parseNote, requestStatus, waitingForViewer, type ProposalFacts } from './requests'
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
  it('groups proposals by note.group in seq order; others stand alone', () => {
    const reqs = groupRequests(state([proposal('p2', note(1, 2)), proposal('p1', note(0, 2)), proposal('solo', 'made elsewhere')]), CID)
    const forge = reqs.find((r) => r.forge)!
    expect(forge.id).toBe('0123456789abcdef')
    expect(forge.proposals.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(forge.malformed).toBe(false)
    const solo = reqs.find((r) => !r.forge)!
    expect(solo.id).toBe('solo')
    expect(solo.title).toBeNull()
  })

  it('someone reusing a group gets a request of their own and leaves the original whole', () => {
    const reqs = groupRequests(state([proposal('p1', note(0, 1)), proposal('p2', note(0, 1), { from: B, at: '2026-11-25T00:00:00.000Z' })]), CID)
    expect(reqs).toHaveLength(2)
    expect(reqs.every((r) => !r.malformed)).toBe(true)
    expect(reqs.find((r) => r.from === A)!.id).toBe('0123456789abcdef')
    expect(reqs.find((r) => r.from === B)!.id).toBe(`0123456789abcdef-${B.slice(0, 8)}`)
    const backdated = groupRequests(state([proposal('p1', note(0, 1)), proposal('p2', note(0, 1), { from: B, at: '2000-01-01T00:00:00.000Z', status: 'invalid' })]), CID)
    expect(backdated.find((r) => r.from === A)!.id).toBe('0123456789abcdef')
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
  const nonces = { p1: facts(5n), p2: facts(6n) } as Record<string, ProposalFacts>
  const at = (n: bigint) => () => n

  it('collecting, ready, done, expired, invalid', () => {
    expect(requestStatus(req!, (id) => nonces[id], at(4n))).toBe('collecting')
    const ready = { ...req!, proposals: req!.proposals.map((p) => ({ ...p, status: 'ready' as const })) }
    expect(requestStatus(ready, (id) => nonces[id], at(4n))).toBe('ready')
    const done = { ...req!, proposals: req!.proposals.map((p) => ({ ...p, status: 'executed' as const })) }
    expect(requestStatus(done, (id) => nonces[id], at(9n))).toBe('done')
    expect(requestStatus(done, (id) => ({ ...nonces[id]!, unproven: true }), at(4n))).toBe('ready')
    expect(requestStatus(req!, (id) => nonces[id], at(5n))).toBe('expired')
    expect(requestStatus(req!, (id) => nonces[id], at(7n | (3n << 40n)))).toBe('collecting')
    expect(requestStatus(req!, (id) => ({ ...nonces[id]!, onChain: id === 'p1' }), at(5n))).toBe('collecting')
    expect(requestStatus(req!, (id) => ({ ...nonces[id]!, onChain: true }), at(6n))).toBe('done')
    expect(requestStatus(req!, (id) => ({ ...nonces[id]!, reviewProblems: id === 'p2' ? ['bad'] : [] }), at(4n))).toBe('invalid')
    const invalid = { ...req!, proposals: [{ ...req!.proposals[0]!, status: 'invalid' as const }, req!.proposals[1]!] }
    expect(requestStatus(invalid, (id) => nonces[id], at(4n))).toBe('invalid')
  })
})

describe('request card', () => {
  it('one primary state per status', () => {
    expect(cardState('collecting', 1, 2, false)).toEqual({ kind: 'sign', collected: 1, needed: 2 })
    expect(cardState('collecting', 1, 2, true)).toEqual({ kind: 'signed', missing: 1 })
    expect(cardState('ready', 2, 2, true)).toEqual({ kind: 'finish' })
    expect(cardState('done', 2, 2, true)).toEqual({ kind: 'done' })
    expect(cardState('expired', 1, 2, false)).toEqual({ kind: 'expired' })
    expect(cardState('invalid', 0, 2, false, 'why')).toEqual({ kind: 'invalid', reason: 'why' })
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
