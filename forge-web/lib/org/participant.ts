import { combineShares, signShare, verify } from './bls'
import { participantIndex, publicShareOf, receiveShares } from './ceremony'
import type { MemberKeys } from './derive'
import { sealEnvelope, type Envelope } from './envelope'
import { requirementKey, type ProposalBody, type RoomState } from './state'
import { assert, getOwn, unhex } from './util'

function myCeremony(state: RoomState, cid: string, keys: MemberKeys) {
  const c = getOwn(state.ceremonies, cid)
  assert(c, `unknown ceremony ${cid}`)
  const me = participantIndex(c.config, keys.authPub)
  assert(me, 'you are not a participant in this ceremony')
  return { c, me }
}

export function recoverShares(seed: Uint8Array, keys: MemberKeys, state: RoomState, cid: string): { index: number; shares: Record<string, bigint> } {
  const { c, me } = myCeremony(state, cid, keys)
  assert(c.status === 'complete' && c.result, `ceremony ${cid.slice(0, 12)} is not complete`)
  const { shares, problems } = receiveShares(seed, keys, c.config, cid, c.reveals)
  assert(!problems.length, `cannot recover shares: ${problems.join('; ')}`)
  for (const [slot, share] of Object.entries(shares)) {
    assert(publicShareOf(share) === c.result.keys[slot]!.publicShares[me], `recovered ${slot} share does not match the public transcript (wrong seed?)`)
  }
  return { index: me, shares }
}

export function propose(keys: MemberKeys, room: string, body: ProposalBody, at?: string): Envelope {
  return sealEnvelope(keys, room, 'proposal', body as unknown as Record<string, unknown>, at)
}

export function approveBody(seed: Uint8Array, keys: MemberKeys, state: RoomState, body: ProposalBody): Record<string, { index: number; share: string }> {
  const message = unhex(body.signable)
  const shares: Record<string, { index: number; share: string }> = {}
  for (const r of body.requirements) {
    const c = getOwn(state.ceremonies, r.cid)
    if (!c || !participantIndex(c.config, keys.authPub)) continue
    const { index, shares: mine } = recoverShares(seed, keys, state, r.cid)
    const share = mine[r.slot]
    assert(share !== undefined, `slot ${r.slot} not in ceremony ${r.cid.slice(0, 12)}`)
    shares[requirementKey(r)] = { index, share: signShare(share, message) }
  }
  assert(Object.keys(shares).length, 'you hold no share for any key this proposal needs')
  return shares
}

export function approve(seed: Uint8Array, keys: MemberKeys, room: string, state: RoomState, proposalId: string, at?: string): Envelope {
  const p = getOwn(state.proposals, proposalId)
  assert(p, `unknown proposal ${proposalId}`)
  return sealEnvelope(keys, room, 'approve', { proposalId, shares: approveBody(seed, keys, state, p.body) }, at)
}

export interface Combined {
  readonly signature: string
  readonly signers: number[]
  readonly groupPublicKey: string
}

export function combine(state: RoomState, proposalId: string): Record<string, Combined> {
  const p = getOwn(state.proposals, proposalId)
  assert(p, `unknown proposal ${proposalId}`)
  assert(p.status === 'ready' || p.status === 'executed', `proposal is ${p.status}${p.error ? `: ${p.error}` : ''}`)
  const message = unhex(p.body.signable)
  const signatures: Record<string, Combined> = {}
  for (const r of p.requirements) {
    const indices = Object.keys(r.shares)
      .map(Number)
      .sort((a, b) => a - b)
      .slice(0, r.threshold ?? 0)
    const signature = combineShares(Object.fromEntries(indices.map((i) => [i, r.shares[i] as string])))
    const groupPublicKey = state.ceremonies[r.cid]!.result!.keys[r.slot]!.groupPublicKey
    assert(verify(signature, message, groupPublicKey), `${r.key}: combined signature does not verify under the group key`)
    signatures[r.key] = { signature, signers: indices, groupPublicKey }
  }
  return signatures
}

export function reject(keys: MemberKeys, room: string, proposalId: string, reason: string, at?: string): Envelope {
  return sealEnvelope(keys, room, 'reject', { proposalId, reason }, at)
}

export function recordBroadcast(keys: MemberKeys, room: string, proposalId: string, result: Record<string, unknown>, at?: string): Envelope {
  return sealEnvelope(keys, room, 'broadcast', { proposalId, result }, at)
}
