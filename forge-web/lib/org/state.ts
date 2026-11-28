import { verify } from './bls'
import {
  SLOT_PATTERN,
  checkRevealShape,
  ceremonyId,
  groupKeys,
  isDtiNetwork,
  participantIndex,
  revealDigest,
  transcriptDigest,
  validateConfig,
  type CeremonyConfig,
  type KeySlot,
  type Reveal,
  type SlotKeys,
} from './ceremony'
import { envelopeId, verifyEnvelope, type Envelope } from './envelope'
import { digest, getOwn, isHex, isObject, memo, sha256hex, unhex } from './util'

const verifiedEnvelope = memo(verifyEnvelope, envelopeId)
const cachedShape = memo(checkRevealShape, (_config, cid, reveal, index) => `${cid}|${index}|${revealDigest(reveal)}`)
const cachedGroupKeys = memo(
  groupKeys,
  (config, reveals) => digest({ config, reveals: Object.keys(reveals).sort().map((i) => revealDigest(reveals[Number(i)])) }),
  200,
)
const cachedVerify = memo(verify, (sig, message, pk) => `${sig}|${pk}|${sha256hex(message)}`)

const ORDER = ['hello', 'config', 'accept', 'dkg-commit', 'dkg-reveal', 'dkg-complete', 'dkg-complaint', 'proposal', 'approve', 'reject', 'broadcast']

export interface Requirement {
  readonly cid: string
  readonly slot: string
}
export const requirementKey = (r: Requirement): string => `${r.cid}/${r.slot}`

export interface ProposalBody {
  readonly network: string
  readonly intent: { readonly type: string } & Record<string, unknown>
  readonly unsigned: string
  readonly signable: string
  readonly requirements: readonly Requirement[]
  readonly derived?: Record<string, unknown>
  readonly note?: string
}

export interface ShareEntry {
  readonly index: number
  readonly share: string
}

export interface Approval {
  readonly id: string
  readonly at: string
  readonly shares: Readonly<Record<string, ShareEntry>>
}

export interface BroadcastRecord {
  readonly id: string
  readonly from: string
  readonly at: string
  readonly result: { readonly ok?: unknown; readonly confirmed?: unknown; readonly error?: unknown }
}

export interface RequirementState {
  readonly cid: string
  readonly slot: string
  readonly key: string
  readonly threshold: number | null
  readonly shares: Record<number, string>
  readonly invalidShares: number[]
  error?: string
}

export type ProposalStatus = 'collecting' | 'ready' | 'executed' | 'invalid'

export interface Proposal {
  readonly id: string
  readonly from: string
  readonly at: string
  readonly body: ProposalBody
  readonly approvals: Record<string, Approval>
  readonly rejections: Record<string, { id: string; at: string; reason: string }>
  readonly broadcasts: BroadcastRecord[]
  requirements: RequirementState[]
  status: ProposalStatus
  error?: string
  executedBy: BroadcastRecord | null
  lastBroadcastError?: unknown
}

export interface CeremonyResult {
  readonly cid: string
  readonly network: string
  readonly threshold: number
  readonly transcript: string
  readonly keys: Readonly<Record<string, KeySlot & SlotKeys>>
}

export interface Ceremony {
  readonly cid: string
  readonly config: CeremonyConfig
  readonly configMessage: string
  readonly configAt: string
  readonly raw: { commits: Record<number, string[]>; reveals: Record<number, unknown[]>; completes: Record<number, CompleteBody[]> }
  reveals: Record<number, Reveal>
  revealDigests: Record<number, string>
  status: 'complete' | 'incomplete'
  result: CeremonyResult | null
}

interface CompleteBody {
  readonly reveals?: unknown
  readonly transcript: string
  readonly keys: Record<string, { groupPublicKey?: unknown; publicSharesDigest?: unknown } | undefined>
}

export interface RoomState {
  readonly hellos: Record<string, { authPub: string; name: string; at: string }>
  readonly ceremonies: Record<string, Ceremony>
  readonly proposals: Record<string, Proposal>
  readonly messageCount: number
}

const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>
const count = (o: object): number => Object.keys(o).length
const push = <T>(map: Record<number, T[]>, key: number, value: T): void => {
  ;(map[key] ??= []).push(value)
}

function sortMessages(messages: Iterable<Envelope & { id: string }>): (Envelope & { id: string })[] {
  return [...messages].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}

export function validProposalBody(b: unknown): b is ProposalBody {
  if (!isObject(b) || !isDtiNetwork(b['network'])) return false
  const intent = b['intent']
  if (!isObject(intent) || typeof intent['type'] !== 'string') return false
  if (!isHex(b['unsigned']) || !isHex(b['signable']) || !(b['signable'] as string).length) return false
  const reqs = b['requirements']
  if (!Array.isArray(reqs) || !reqs.length || reqs.length > 16) return false
  if (!reqs.every((r) => isObject(r) && isHex(r['cid'], 32) && typeof r['slot'] === 'string' && SLOT_PATTERN.test(r['slot']))) return false
  if (new Set(reqs.map((r) => requirementKey(r as Requirement))).size !== reqs.length) return false
  if (b['derived'] !== undefined && !isObject(b['derived'])) return false
  return b['note'] === undefined || typeof b['note'] === 'string'
}

export interface ReduceOptions {
  readonly room?: string
  /** Completed ceremonies given as they are (an organization's roster). */
  readonly ceremonies?: readonly Ceremony[]
  /** When Platform first carried each envelope (by id): the `at` it is ordered and shown by. */
  readonly carriedAt?: ReadonlyMap<string, string>
}

export function reduce(messages: Iterable<unknown>, { room, ceremonies: known = [], carriedAt }: ReduceOptions = {}): RoomState {
  const byId = new Map<string, Envelope & { id: string }>()
  for (const m of messages) {
    let id: string
    try {
      id = envelopeId(m)
    } catch {
      continue
    }
    if (byId.has(id)) continue
    if (!verifiedEnvelope(m)) continue
    const e = m as Envelope
    if (room && e.room !== room) continue
    byId.set(id, { ...e, id, at: carriedAt?.get(id) ?? e.at })
  }
  const hellos = dict<{ authPub: string; name: string; at: string }>()
  const ceremonies = dict<Ceremony>()
  const proposals = dict<Proposal>()
  for (const c of known) ceremonies[c.cid] = c
  const given = new Set(known.map((c) => c.cid))

  for (const m of sortMessages(byId.values())) {
    const b = isObject(m.body) ? m.body : {}
    const c = getOwn(ceremonies, b['cid'])
    const idx = c ? participantIndex(c.config, m.from) : null
    try {
      switch (m.type) {
        case 'hello':
          if (typeof b['name'] === 'string' && isHex(b['transportPub'], 32)) {
            hellos[m.from] = { authPub: m.from, name: b['name'].slice(0, 64), at: hellos[m.from]?.at ?? m.at }
          }
          break
        case 'config': {
          const config = validateConfig(b['config'])
          if (m.from !== config.organizer) throw new Error('config not sent by its organizer')
          if (config.room !== m.room) throw new Error('config is for another room')
          const cid = ceremonyId(config)
          if (!Object.hasOwn(ceremonies, cid)) {
            ceremonies[cid] = { cid, config, configMessage: m.id, configAt: m.at, raw: { commits: {}, reveals: {}, completes: {} }, reveals: {}, revealDigests: {}, status: 'incomplete', result: null }
          }
          break
        }
        case 'dkg-commit':
          if (c && idx && isHex(b['digest'], 32)) push(c.raw.commits, idx, b['digest'])
          break
        case 'dkg-reveal':
          if (c && idx && b['reveal'] && typeof b['reveal'] === 'object') push(c.raw.reveals, idx, b['reveal'])
          break
        case 'dkg-complete':
          if (c && idx && typeof b['transcript'] === 'string' && b['keys'] && typeof b['keys'] === 'object') push(c.raw.completes, idx, b as unknown as CompleteBody)
          break
        case 'proposal':
          if (!validProposalBody(b)) throw new Error('malformed proposal')
          proposals[m.id] = { id: m.id, from: m.from, at: m.at, body: b, approvals: dict(), rejections: dict(), broadcasts: [], requirements: [], status: 'invalid', executedBy: null }
          break
        case 'approve': {
          const p = getOwn(proposals, b['proposalId'])
          if (p && !Object.hasOwn(p.approvals, m.from) && b['shares'] && typeof b['shares'] === 'object') {
            p.approvals[m.from] = { id: m.id, at: m.at, shares: b['shares'] as Record<string, ShareEntry> }
          }
          break
        }
        case 'reject': {
          const p = getOwn(proposals, b['proposalId'])
          if (p) p.rejections[m.from] = { id: m.id, at: m.at, reason: String(b['reason'] ?? '').slice(0, 500) }
          break
        }
        case 'broadcast': {
          const p = getOwn(proposals, b['proposalId'])
          if (p && b['result'] && typeof b['result'] === 'object') p.broadcasts.push({ id: m.id, from: m.from, at: m.at, result: b['result'] as BroadcastRecord['result'] })
          break
        }
        default:
          break
      }
    } catch {
      /* an invalid message is ignored */
    }
  }

  for (const c of Object.values(ceremonies)) {
    if (given.has(c.cid)) continue
    try {
      finishCeremony(c)
    } catch {
      c.status = 'incomplete'
      c.result = null
    }
  }
  for (const p of Object.values(proposals)) {
    try {
      finishProposal(p, ceremonies)
    } catch (e) {
      p.status = 'invalid'
      p.error = e instanceof Error ? e.message : String(e)
    }
  }
  return { hellos, ceremonies, proposals, messageCount: byId.size }
}

interface ValidReveal {
  readonly reveal: Reveal
  readonly digest: string
}

function validReveals(c: Ceremony, index: number): ValidReveal[] {
  const commits = [...new Set(c.raw.commits[index] ?? [])]
  const out: ValidReveal[] = []
  for (const reveal of c.raw.reveals[index] ?? []) {
    const d = revealDigest(reveal)
    if (!commits.includes(d) || out.some((x) => x.digest === d)) continue
    if (cachedShape(c.config, c.cid, reveal, index).length) continue
    out.push({ reveal: reveal as Reveal, digest: d })
  }
  return out
}

function completionMatches(c: Ceremony, body: CompleteBody, keys: Record<string, SlotKeys>, transcript: string): boolean {
  return (
    body.transcript === transcript &&
    c.config.keys.every(
      ({ slot }) =>
        body.keys?.[slot]?.groupPublicKey === keys[slot]!.groupPublicKey && body.keys?.[slot]?.publicSharesDigest === digest(keys[slot]!.publicShares),
    )
  )
}

function agreedCompletion(c: Ceremony, participants: number[], per: Record<number, ValidReveal[]>): { chosen: ValidReveal[]; keys: Record<string, SlotKeys>; transcript: string } | null {
  const completesOf = (i: number): CompleteBody[] => c.raw.completes[i] ?? []
  const listOf = (body: CompleteBody): string | null =>
    Array.isArray(body.reveals) && body.reveals.length === participants.length && body.reveals.every((d) => isHex(d, 32)) ? body.reveals.join(',') : null
  const candidates = new Set(completesOf(participants[0] as number).map(listOf).filter((x): x is string => x !== null))
  for (const candidate of candidates) {
    const digests = candidate.split(',')
    if (!participants.every((i) => completesOf(i).some((body) => listOf(body) === candidate))) continue
    const chosen = participants.map((i, k) => (per[i] as ValidReveal[]).find((r) => r.digest === digests[k]))
    if (chosen.some((r) => !r)) continue
    const picked = chosen as ValidReveal[]
    const transcript = transcriptDigest(c.cid, c.config, Object.fromEntries(participants.map((i, k) => [i, digests[k] as string])))
    let keys: Record<string, SlotKeys>
    try {
      keys = cachedGroupKeys(c.config, Object.fromEntries(participants.map((i, k) => [i, picked[k]!.reveal])))
    } catch {
      continue
    }
    if (participants.every((i) => completesOf(i).some((body) => listOf(body) === candidate && completionMatches(c, body, keys, transcript)))) {
      return { chosen: picked, keys, transcript }
    }
  }
  return null
}

function finishCeremony(c: Ceremony): void {
  const participants = c.config.participants.map((p) => p.index)
  c.result = null
  c.status = 'incomplete'
  if (!participants.every((i) => (c.raw.completes[i] ?? []).length)) return
  const per = Object.fromEntries(participants.map((i) => [i, validReveals(c, i)])) as Record<number, ValidReveal[]>
  const agreed = agreedCompletion(c, participants, per)
  if (!agreed) return
  participants.forEach((i, k) => {
    c.reveals[i] = agreed.chosen[k]!.reveal
    c.revealDigests[i] = agreed.chosen[k]!.digest
  })
  c.status = 'complete'
  c.result = {
    cid: c.cid,
    network: c.config.network,
    threshold: c.config.threshold,
    transcript: agreed.transcript,
    keys: Object.fromEntries(c.config.keys.map((k) => [k.slot, { ...k, ...agreed.keys[k.slot]! }])),
  }
}

function finishProposal(p: Proposal, ceremonies: Record<string, Ceremony>): void {
  const b = p.body
  p.requirements = []
  p.status = 'invalid'
  const member = (authPub: string): boolean => b.requirements.some((r) => Object.hasOwn(ceremonies, r.cid) && participantIndex(ceremonies[r.cid]!.config, authPub) !== null)
  if (!member(p.from)) {
    p.error = 'proposer is not a member of any required ceremony'
    return
  }
  const message = unhex(b.signable)
  let ready = true
  for (const r of b.requirements) {
    const c = getOwn(ceremonies, r.cid)
    const key = requirementKey(r)
    const entry: RequirementState = { cid: r.cid, slot: r.slot, key, threshold: c?.config.threshold ?? null, shares: {}, invalidShares: [] }
    p.requirements.push(entry)
    if (!c || c.status !== 'complete' || !c.result || !Object.hasOwn(c.result.keys, r.slot)) {
      entry.error = 'ceremony not complete or slot unknown'
      ready = false
      continue
    }
    const publicShares = c.result.keys[r.slot]!.publicShares
    for (const [authPub, approval] of Object.entries(p.approvals)) {
      const idx = participantIndex(c.config, authPub)
      const s = getOwn(approval.shares, key)
      if (!idx || !s) continue
      if (s.index === idx && typeof s.share === 'string' && cachedVerify(s.share, message, publicShares[idx] as string)) entry.shares[idx] = s.share
      else entry.invalidShares.push(idx)
    }
    if (count(entry.shares) < c.config.threshold) ready = false
  }
  const memberBroadcasts = p.broadcasts.filter((x) => member(x.from))
  const ok = ready && (memberBroadcasts.find((x) => x.result.ok === true && x.result.confirmed === true) ?? memberBroadcasts.find((x) => x.result.ok === true))
  p.status = ok ? 'executed' : ready ? 'ready' : 'collecting'
  p.executedBy = ok || null
  if (!ok && memberBroadcasts.length) p.lastBroadcastError = memberBroadcasts.at(-1)!.result.error
}
