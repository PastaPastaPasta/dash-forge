import type { Proposal, RoomState } from './state'
import { isNonceSpent } from '../sdk/nonce'
import { isObject } from './util'

export interface ForgeNote {
  readonly group: string
  readonly seq: number
  readonly of: number
  readonly title: string
}

export const NOTE_GROUP = /^[0-9a-f]{16}$/

export function parseNote(note: string | undefined): ForgeNote | null {
  if (typeof note !== 'string') return null
  let v: unknown
  try {
    v = JSON.parse(note)
  } catch {
    return null
  }
  if (!isObject(v) || v['forge'] !== 1) return null
  const { group, seq, of, title } = v
  if (typeof group !== 'string' || !NOTE_GROUP.test(group)) return null
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(of) || (seq as number) < 0 || (of as number) < 1 || (seq as number) >= (of as number)) return null
  if (typeof title !== 'string' || title.length > 120) return null
  return { group, seq: seq as number, of: of as number, title }
}

export function makeNote(n: ForgeNote): string {
  return JSON.stringify({ forge: 1, group: n.group, seq: n.seq, of: n.of, title: n.title.slice(0, 120) })
}

export function newGroupId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface OrgRequest {
  readonly id: string
  readonly title: string | null
  readonly forge: boolean
  readonly proposals: readonly Proposal[]
  readonly from: string
  readonly at: string
  readonly malformed: boolean
}

export function groupRequests(state: RoomState, cid: string): OrgRequest[] {
  const groups = new Map<string, { note: ForgeNote; p: Proposal }[]>()
  const out: OrgRequest[] = []
  for (const p of Object.values(state.proposals)) {
    if (!p.body.requirements.some((r) => r.cid === cid)) continue
    const note = parseNote(p.body.note)
    if (note === null) {
      out.push({ id: p.id, title: null, forge: false, proposals: [p], from: p.from, at: p.at, malformed: false })
      continue
    }
    const list = groups.get(note.group) ?? []
    list.push({ note, p })
    groups.set(note.group, list)
  }
  for (const [id, list] of groups) {
    list.sort((a, b) => a.note.seq - b.note.seq || a.p.id.localeCompare(b.p.id))
    const first = list[0]!
    const of = first.note.of
    const malformed =
      list.length !== of ||
      list.some((x, i) => x.note.seq !== i || x.note.of !== of || x.p.from !== first.p.from)
    out.push({ id, title: first.note.title, forge: true, proposals: list.map((x) => x.p), from: first.p.from, at: first.p.at, malformed })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
}

export type RequestStatus = 'collecting' | 'ready' | 'done' | 'expired' | 'invalid'

export interface ProposalFacts {
  readonly reviewProblems: readonly string[]
  readonly nonce: bigint | null
  readonly contractId: string | null
  readonly onChain: boolean
}

export function proposalDone(p: Proposal, facts: ProposalFacts | undefined): boolean {
  return p.status === 'executed' || facts?.onChain === true
}

export function requestStatus(
  req: OrgRequest,
  facts: (proposalId: string) => ProposalFacts | undefined,
  currentNonce: (contractId: string) => bigint | undefined,
): RequestStatus {
  if (req.malformed || req.proposals.some((p) => p.status === 'invalid')) return 'invalid'
  if (req.proposals.every((p) => proposalDone(p, facts(p.id)))) return 'done'
  for (const p of req.proposals) {
    const f = facts(p.id)
    if (proposalDone(p, f) || !f || f.nonce === null || f.contractId === null) continue
    const current = currentNonce(f.contractId)
    if (current !== undefined && isNonceSpent(current, f.nonce)) return 'expired'
  }
  if (req.proposals.some((p) => (facts(p.id)?.reviewProblems.length ?? 0) > 0)) return 'invalid'
  if (req.proposals.some((p) => p.status === 'collecting' && !proposalDone(p, facts(p.id)))) return 'collecting'
  return 'ready'
}

export function sharesCollected(req: OrgRequest, cid: string, slot: string): number {
  let least = Infinity
  for (const p of req.proposals) {
    if (p.status === 'executed') continue
    const r = p.requirements.find((x) => x.cid === cid && x.slot === slot)
    least = Math.min(least, r ? Object.keys(r.shares).length : 0)
  }
  return least === Infinity ? (req.proposals[0]?.requirements.find((x) => x.cid === cid)?.threshold ?? 0) : least
}

export function signedBy(req: OrgRequest, authPub: string): boolean {
  return req.proposals.every((p) => p.status === 'executed' || Object.hasOwn(p.approvals, authPub))
}

export function declinedBy(req: OrgRequest, authPub: string): boolean {
  return req.proposals.some((p) => Object.hasOwn(p.rejections, authPub))
}

export type CardState =
  | { readonly kind: 'sign'; readonly collected: number; readonly needed: number }
  | { readonly kind: 'signed'; readonly missing: number }
  | { readonly kind: 'finish' }
  | { readonly kind: 'done' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'invalid'; readonly reason: string }

export function cardState(status: RequestStatus, collected: number, needed: number, viewerSigned: boolean, reason = ''): CardState {
  switch (status) {
    case 'done':
      return { kind: 'done' }
    case 'expired':
      return { kind: 'expired' }
    case 'invalid':
      return { kind: 'invalid', reason }
    case 'ready':
      return { kind: 'finish' }
    default:
      return viewerSigned ? { kind: 'signed', missing: Math.max(needed - collected, 0) } : { kind: 'sign', collected, needed }
  }
}

export function waitingForViewer(status: RequestStatus, viewerSigned: boolean, viewerDeclined: boolean): boolean {
  return status === 'collecting' && !viewerSigned && !viewerDeclined
}
