import type { Proposal, RoomState } from './state'
import { isObject, sameFields } from './util'

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

/**
 * Every request of the ceremony `cid`. A request is one proposer's proposals sharing a group, and
 * its id is `<group>-<first 16 hex of the proposer's key>`, so nobody can claim another member's
 * id (§11.5). A proposal without a Forge note is a request of its own, under the proposal's id.
 * dg groups the same way (`request::requests`).
 */
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
    const key = `${note.group}\u0000${p.from}`
    const list = groups.get(key) ?? []
    list.push({ note, p })
    groups.set(key, list)
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.note.seq - b.note.seq || a.p.id.localeCompare(b.p.id))
    const head = list[0]!
    const of = head.note.of
    const malformed = list.length !== of || list.some((x, i) => x.note.seq !== i || x.note.of !== of)
    out.push({
      id: requestId(head.note.group, head.p.from),
      title: head.note.title,
      forge: true,
      proposals: list.map((x) => x.p),
      from: head.p.from,
      at: list.map((x) => x.p.at).reduce((a, b) => (b < a ? b : a)),
      malformed,
    })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
}

export const requestId = (group: string, from: string): string => `${group}-${from.slice(0, 16)}`

/**
 * The request `query` names: its exact id, else the one request whose id starts with it (at least
 * four characters), so a bare group id resolves when exactly one proposer used it.
 */
export function findRequest<T extends { readonly request: OrgRequest }>(views: readonly T[], query: string): T | null {
  const exact = views.find((v) => v.request.id === query)
  if (exact) return exact
  if (query.length < 4) return null
  const matches = views.filter((v) => v.request.id.startsWith(query))
  return matches.length === 1 ? (matches[0] as T) : null
}

export type RequestStatus = 'collecting' | 'ready' | 'done' | 'expired' | 'declined' | 'invalid'

export interface ProposalFacts {
  /** What review found wrong with the write itself: the request is `invalid`. */
  readonly reviewProblems: readonly string[]
  /** Why the organization's nonce does not let the write land (too far ahead). */
  readonly nonceProblem?: string | null
  /** The organization's nonce could not be read: nothing can be signed until it is. */
  readonly nonceUnread?: boolean
  readonly nonce: bigint | null
  readonly contractId: string | null
  /** Its nonce is spent. */
  readonly spent?: boolean
  /** Its write is visible on Platform (§11.6). */
  readonly onChain: boolean
  /** A create a member reported, its nonce spent, whose document is no longer there. */
  readonly gone?: boolean
  /** A replace whose document moved past its revision without it: it can never land, and holds no nonce. */
  readonly superseded?: boolean
}


export function proposalDone(facts: ProposalFacts | undefined): boolean {
  return facts?.onChain === true || facts?.gone === true
}

/** The stored document a part's write is checked against: null when it is not there. */
export interface StoredWrite {
  readonly revision: bigint
  readonly fields: Readonly<Record<string, unknown>>
}

export interface PartWrite {
  /** Its write is visible on Platform. */
  readonly landed: boolean
  /** It can never land: a replace whose document is not at the revision it replaces, or a delete whose document is gone. */
  readonly superseded: boolean
  /** Its document is not on Platform. */
  readonly absent: boolean
}

/**
 * What Platform shows of one part's write (§9, §11.6): a create or replace landed once its document
 * is at the part's revision with its fields (a create's is 1), or later with its nonce spent and a
 * member's claim; a delete once its document is gone with its nonce spent and a claim. Until then a
 * create waits only while its document is absent, a replace only while its document is at the
 * revision it replaces, and a delete only while its document is there.
 */
export function partWrite(
  action: string,
  stored: StoredWrite | null,
  want: { readonly revision: bigint | null; readonly fields: Readonly<Record<string, unknown>> },
  spent: boolean,
  claimed: boolean,
): PartWrite {
  const absent = stored === null
  if (action === 'delete') {
    const landed = absent && spent && claimed
    return { landed, superseded: !landed && absent, absent }
  }
  const revision = want.revision ?? (action === 'create' ? 1n : 0n)
  const landed = stored !== null && ((stored.revision === revision && sameFields(want.fields, stored.fields)) || (stored.revision > revision && spent && claimed))
  const waiting = action === 'create' ? absent : stored?.revision === revision - 1n
  return { landed, superseded: !landed && !waiting, absent }
}

/** A create a member reported done, its nonce spent and no other request's write on it, whose document is gone. */
export const goneCreate = (action: string, claimed: boolean, spent: boolean, absent: boolean | undefined, takenByOther: boolean): boolean =>
  action === 'create' && claimed && spent && absent === true && !takenByOther

/**
 * A request's status: problems in its shape or review make it `invalid`, which wins over
 * `declined`, then `done`, `expired`, `ready` and `collecting` (§9, §11.3). dg takes the same order.
 */
export function requestStatus(req: OrgRequest, facts: (proposalId: string) => ProposalFacts | undefined, declined = false): RequestStatus {
  const open = req.proposals.filter((p) => !proposalDone(facts(p.id)))
  if (req.malformed || req.proposals.some((p) => p.status === 'invalid' || (facts(p.id)?.reviewProblems.length ?? 1) > 0)) return 'invalid'
  if (open.some((p) => facts(p.id)?.nonceProblem)) return 'invalid'
  if (declined) return 'declined'
  if (open.length === 0) return 'done'
  if (open.some((p) => facts(p.id)?.spent === true || facts(p.id)?.superseded === true)) return 'expired'
  if (open.some((p) => p.status === 'collecting')) return 'collecting'
  return 'ready'
}

/** Still collecting, and so many members declined it without approving that the rest cannot reach the threshold. */
export function declinedOut(req: OrgRequest, members: ReadonlySet<string>, threshold: number): boolean {
  if (req.proposals.some((p) => p.status === 'ready' || p.status === 'executed')) return false
  const approved = new Set(req.proposals.flatMap((p) => Object.keys(p.approvals)))
  const declined = new Set(req.proposals.flatMap((p) => Object.keys(p.rejections)).filter((k) => members.has(k) && !approved.has(k)))
  return declined.size > members.size - threshold
}

export const MALFORMED = 'its parts are missing, repeated, or from different members'

/** Why review refuses the request, for "Forge won't sign this: <reasons>". */
export function refusalReasons(req: OrgRequest, facts: (proposalId: string) => ProposalFacts | undefined): string[] {
  const reasons = new Set<string>(req.malformed ? [MALFORMED] : [])
  for (const p of req.proposals) {
    if (p.status === 'invalid') reasons.add(p.error ?? 'a part is not a valid proposal')
    const f = facts(p.id)
    if (!f) reasons.add('its transition cannot be read')
    for (const r of f?.reviewProblems ?? []) reasons.add(r)
    if (f?.nonceProblem && !proposalDone(f)) reasons.add(f.nonceProblem)
  }
  return [...reasons]
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
  | { readonly kind: 'declined'; readonly needed: number; readonly size: number }
  | { readonly kind: 'invalid'; readonly reasons: readonly string[] }

export function cardState(status: RequestStatus, collected: number, needed: number, viewerSigned: boolean, reasons: readonly string[] = [], size = 0): CardState {
  switch (status) {
    case 'done':
      return { kind: 'done' }
    case 'expired':
      return { kind: 'expired' }
    case 'declined':
      return { kind: 'declined', needed, size }
    case 'invalid':
      return { kind: 'invalid', reasons }
    case 'ready':
      return { kind: 'finish' }
    case 'collecting':
      return viewerSigned ? { kind: 'signed', missing: Math.max(needed - collected, 0) } : { kind: 'sign', collected, needed }
  }
}

export function waitingForViewer(status: RequestStatus, viewerSigned: boolean, viewerDeclined: boolean): boolean {
  return status === 'collecting' && !viewerSigned && !viewerDeclined
}

export const declinedText = (needed: number, size: number): string => `Declined: too many members declined it to reach ${needed} of ${size}.`

export const refusedText = (reasons: readonly string[]): string => `Forge won't sign this: ${reasons.length ? reasons.join('; ') : 'it is not an action Forge recognises'}.`
