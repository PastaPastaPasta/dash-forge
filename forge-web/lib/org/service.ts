import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Encode } from '../auth/base58'
import type { Network } from '../constants'
import type { ForgeIds } from '../deployments'
import { rc1WriteProblem } from '../layout'
import { DOC } from '../repo/contract'
import { isNonceSpent, isNonceTooFar, nonceTip } from '../sdk/nonce'
import { broadcastPresigned } from '../sdk/write'
import { resolveDpnsName } from '../view/dpns'
import { shortIdentity } from '../view/format'
import { participantIndex } from './ceremony'
import { describeTransition } from './describe'
import { envelopeId, sealEnvelope, type Envelope } from './envelope'
import { findOrgIdentity, type OrgIdentity } from './identity'
import { parseInvite, roomOnNetwork } from './invite'
import { approveBody, combine, propose, recordBroadcast, reject } from './participant'
import { pullRoom, postEnvelopes, type RoomLog } from './relay'
import {
  cardState,
  declinedBy,
  groupRequests,
  makeNote,
  newGroupId,
  proposalDone,
  requestStatus,
  sharesCollected,
  signedBy,
  type CardState,
  type OrgRequest,
  type ProposalFacts,
  type RequestStatus,
} from './requests'
import { reduce, requirementKey, type ProposalBody, type RoomState } from './state'
import { saveOrg, type OrgMember, type OrgRecord, type Unlocked } from './store'
import { buildUnsigned, decodeUnsigned, intentFor, reviewDecoded, signedTransition, type DecodedTransition, type WriteSpec } from './transition'
import { assert } from './util'


interface Facades {
  identities: { contractNonce(identityId: string, contractId: string): Promise<bigint | undefined> }
  documents: { get(contractId: string, type: string, id: string): Promise<{ revision?: bigint; toObject(): Record<string, unknown> } | undefined | null> }
}
const facades = (sdk: EvoSDK): Facades => sdk as unknown as Facades

const logs = new Map<string, RoomLog>()
const identities = new Map<string, OrgIdentity>()
const decodes = new Map<string, Promise<DecodedTransition | null>>()

export async function syncRoom(relay: string, room: string): Promise<RoomState> {
  const key = `${relay}|${room}`
  const log = await pullRoom(relay, room, logs.get(key))
  logs.set(key, log)
  return reduce(log.messages, { room })
}

export interface ConnectCandidate {
  readonly invite: { readonly room: string; readonly relay: string; readonly label: string | null }
  readonly identity: OrgIdentity
  readonly label: string
  readonly threshold: number
  readonly members: readonly (OrgMember & { readonly fingerprint: string })[]
}

export class ConnectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectError'
  }
}

export async function verifyInvite(sdk: EvoSDK, text: string, network: string): Promise<ConnectCandidate> {
  const invite = parseInvite(text)
  if (invite === null) throw new ConnectError('Paste the invite link from multisig.dashhq.org, or the group id it contains.')
  if (invite.network !== null && invite.network !== network && !roomOnNetwork(invite.room, network)) {
    throw new ConnectError(`This group is on ${invite.network}; this Forge is on ${network}.`)
  }
  const state = await syncRoom(invite.relay, invite.room)
  if (!Object.values(state.ceremonies).some((c) => c.status === 'complete')) {
    throw new ConnectError("This group hasn't finished its key ceremony yet. Finish it in multisig.dashhq.org, then connect.")
  }
  const identity = await findOrgIdentity(sdk, state)
  if (identity === null) throw new ConnectError(`No identity on ${network} uses this group's keys yet. Create the identity in multisig.dashhq.org, then connect.`)
  const { config } = identity.ceremony
  const { fingerprint } = await import('./derive')
  return {
    invite,
    identity,
    label: invite.label ?? config.label,
    threshold: config.threshold,
    members: config.participants.map((p) => ({ index: p.index, name: p.name, authPub: p.authPub, fingerprint: fingerprint(p.authPub, p.transportPub) })),
  }
}

export function connect(candidate: ConnectCandidate, network: string, authPub: string): OrgRecord {
  assert(
    candidate.members.some((m) => m.authPub === authPub),
    'choose one of the members',
  )
  const record: OrgRecord = {
    network,
    orgId: candidate.identity.orgId,
    room: candidate.invite.room,
    relay: candidate.invite.relay,
    authPub,
    label: candidate.label,
    threshold: candidate.threshold,
    members: candidate.members.map(({ index, name, authPub: a }) => ({ index, name, authPub: a })),
  }
  identities.set(`${record.relay}|${record.room}`, candidate.identity)
  saveOrg(record)
  return record
}

async function orgIdentityOf(sdk: EvoSDK, record: OrgRecord, state: RoomState): Promise<OrgIdentity> {
  const key = `${record.relay}|${record.room}`
  const known = identities.get(key)
  if (known && known.orgId === record.orgId && state.ceremonies[known.ceremony.cid]?.status === 'complete') {
    return { ...known, ceremony: state.ceremonies[known.ceremony.cid]! }
  }
  const found = await findOrgIdentity(sdk, state)
  if (found === null || found.orgId !== record.orgId) throw new Error("This group's keys no longer control the organization's identity. Reconnect it from its invite.")
  identities.set(key, found)
  return found
}

function decodeCached(unsigned: string): Promise<DecodedTransition | null> {
  let d = decodes.get(unsigned)
  if (d === undefined) {
    d = decodeUnsigned(unsigned).catch(() => null)
    decodes.set(unsigned, d)
  }
  return d
}

export interface ProposalView {
  readonly id: string
  readonly decoded: DecodedTransition | null
  readonly problems: readonly string[]
  readonly sentence: string
  readonly done: boolean
}

export interface RequestView {
  readonly request: OrgRequest
  readonly status: RequestStatus
  readonly card: CardState
  readonly proposals: readonly ProposalView[]
  readonly collected: number
  readonly needed: number
  readonly proposer: string
  readonly signers: readonly string[]
  readonly decliners: readonly string[]
  readonly viewerSigned: boolean
  readonly viewerDeclined: boolean
}

export interface OrgView {
  readonly record: OrgRecord
  readonly identity: OrgIdentity
  readonly state: RoomState
  readonly requests: readonly RequestView[]
}

export interface LoadOptions {
  readonly network: Network
  readonly forge: ForgeIds
  readonly describe?: boolean
}

function memberName(record: OrgRecord, authPub: string): string {
  const m = record.members.find((x) => x.authPub === authPub)
  return m ? m.name || `Member ${m.index}` : 'Someone outside the organization'
}

async function nonceReader(sdk: EvoSDK, orgId: string, contractIds: Iterable<string>): Promise<(contractId: string) => bigint | undefined> {
  const map = new Map<string, bigint>()
  await Promise.all(
    [...new Set(contractIds)].map(async (c) => {
      try {
        map.set(c, (await facades(sdk).identities.contractNonce(orgId, c)) ?? 0n)
      } catch {
        /* unread: reviews refuse until it reads */
      }
    }),
  )
  return (c) => map.get(c)
}

async function storedDoc(sdk: EvoSDK, contractId: string, type: string, id: string): Promise<{ revision: bigint; data: Record<string, unknown> } | null> {
  const doc = await facades(sdk).documents.get(contractId, type, id)
  return doc ? { revision: doc.revision ?? 1n, data: doc.toObject() } : null
}

async function writtenOnChain(sdk: EvoSDK, d: DecodedTransition): Promise<boolean> {
  try {
    const doc = await storedDoc(sdk, d.contractId, d.documentType, d.documentId)
    if (d.action === 'delete') return doc === null
    if (doc === null) return false
    return d.action === 'create' || doc.revision >= (d.revision ?? 0n)
  } catch {
    return false
  }
}

export async function loadOrg(sdk: EvoSDK, record: OrgRecord, opts: LoadOptions): Promise<OrgView> {
  const state = await syncRoom(record.relay, record.room)
  const identity = await orgIdentityOf(sdk, record, state)
  const requests = groupRequests(state, identity.ceremony.cid)
  const decoded = new Map<string, DecodedTransition | null>()
  await Promise.all(requests.flatMap((r) => r.proposals.map(async (p) => decoded.set(p.id, await decodeCached(p.body.unsigned)))))
  const currentNonce = await nonceReader(
    sdk,
    record.orgId,
    [...decoded.values()].filter((d): d is DecodedTransition => d !== null && d.contractId !== '').map((d) => d.contractId),
  )
  const ctx = { orgId: record.orgId, keyId: identity.keyId, forge: opts.forge, currentNonce }
  const facts = new Map<string, ProposalFacts>()
  for (const r of requests) {
    for (const p of r.proposals) {
      const d = decoded.get(p.id) ?? null
      const current = d ? currentNonce(d.contractId) : undefined
      const onChain = p.status !== 'executed' && d !== null && current !== undefined && isNonceSpent(current, d.nonce) ? await writtenOnChain(sdk, d) : false
      const settled = onChain || p.status === 'executed'
      const problems = settled ? [] : d === null ? ['the transition does not decode'] : reviewDecoded(d, p.body, ctx)
      facts.set(p.id, { reviewProblems: problems, nonce: d?.nonce ?? null, contractId: d?.contractId ?? null, onChain })
    }
  }
  const names = new Map<string, string>()
  const repoNames = new Map<string, string | null>()
  const views: RequestView[] = []
  for (const r of requests) {
    const status = requestStatus(r, (id) => facts.get(id), currentNonce)
    const proposals: ProposalView[] = []
    for (const p of r.proposals) {
      const d = decoded.get(p.id) ?? null
      const f = facts.get(p.id)
      let sentence = 'An action Forge cannot read'
      if (d !== null && opts.describe !== false) {
        sentence = await describe(sdk, d, record, opts, names, repoNames)
      }
      proposals.push({ id: p.id, decoded: d, problems: f?.reviewProblems ?? [], sentence, done: proposalDone(p, f) })
    }
    const slot = identity.slot
    const collected = sharesCollected(r, identity.ceremony.cid, slot)
    const needed = identity.ceremony.config.threshold
    const viewerSigned = signedBy(r, record.authPub)
    const viewerDeclined = declinedBy(r, record.authPub)
    const signerKeys = new Set(r.proposals.flatMap((p) => Object.keys(p.approvals)))
    const declinerKeys = new Set(r.proposals.flatMap((p) => Object.keys(p.rejections)))
    const reason = proposals.flatMap((p) => p.problems)[0] ?? (r.malformed ? 'The parts of this request do not fit together.' : '')
    views.push({
      request: r,
      status,
      card: cardState(status, collected, needed, viewerSigned, reason),
      proposals,
      collected,
      needed,
      proposer: memberName(record, r.from),
      signers: [...signerKeys].map((k) => memberName(record, k)),
      decliners: [...declinerKeys].map((k) => memberName(record, k)),
      viewerSigned,
      viewerDeclined,
    })
  }
  return { record, identity, state, requests: views }
}

async function describe(
  sdk: EvoSDK,
  d: DecodedTransition,
  record: OrgRecord,
  opts: LoadOptions,
  names: Map<string, string>,
  repoNames: Map<string, string | null>,
): Promise<string> {
  const ids = new Set<string>()
  let stored: Record<string, unknown> | null = null
  if (d.action === 'delete' || d.action === 'replace') {
    stored = await storedDoc(sdk, d.contractId, d.documentType, d.documentId)
      .then((s) => s?.data ?? null)
      .catch(() => null)
  }
  const source = d.action === 'delete' ? (stored ?? {}) : d.data
  const memberId = source['memberId'] instanceof Uint8Array ? base58Encode(source['memberId']) : null
  const repoId = source['repoId'] instanceof Uint8Array ? base58Encode(source['repoId']) : null
  if (memberId) ids.add(memberId)
  await Promise.all(
    [...ids].filter((id) => !names.has(id)).map(async (id) => names.set(id, (await resolveDpnsName(sdk, id, opts.network)) ?? shortIdentity(id))),
  )
  if (repoId && !repoNames.has(repoId)) {
    const repo = await storedDoc(sdk, opts.forge.core, DOC.repo, repoId).catch(() => null)
    repoNames.set(repoId, repo ? `${record.label}/${String(repo.data['name'] ?? '')}` : null)
  }
  return describeTransition(d, {
    org: record.label,
    orgId: record.orgId,
    person: (id) => names.get(id) ?? shortIdentity(id),
    repo: (id) => repoNames.get(id) ?? null,
    stored,
  })
}

export function requestLink(orgId: string, requestId: string): string {
  return `/org/?id=${encodeURIComponent(orgId)}&request=${encodeURIComponent(requestId)}`
}

function openNonces(view: OrgView | null, current: (contractId: string) => bigint | undefined): Map<string, bigint> {
  const max = new Map<string, bigint>()
  for (const r of view?.requests ?? []) {
    if (r.status !== 'collecting' && r.status !== 'ready') continue
    for (const p of r.proposals) {
      const d = p.decoded
      const c = d ? current(d.contractId) : undefined
      if (!d || c === undefined || isNonceTooFar(c, d.nonce)) continue
      if ((max.get(d.contractId) ?? 0n) < d.nonce) max.set(d.contractId, d.nonce)
    }
  }
  return max
}

export interface LaterSpec {
  readonly contractId: string
  readonly after: (documentIds: readonly string[]) => WriteSpec
}

export interface CreateRequestInput {
  readonly title: string
  readonly specs: readonly (WriteSpec | LaterSpec)[]
}

const specOf = (s: WriteSpec | LaterSpec, ids: readonly string[]): WriteSpec => ('after' in s ? s.after(ids) : s)

export async function createRequest(
  sdk: EvoSDK,
  record: OrgRecord,
  unlocked: Unlocked,
  input: CreateRequestInput,
  opts: LoadOptions,
): Promise<string> {
  assert(unlocked.keys.authPub === record.authPub, 'unlock with your multisig seed phrase first')
  assert(input.specs.length > 0, 'nothing to request')
  const view = await loadOrg(sdk, record, { ...opts, describe: false })
  const { identity, state } = view
  const current = await nonceReader(sdk, record.orgId, input.specs.map((s) => s.contractId))
  const taken = openNonces(view, current)
  const next = new Map<string, bigint>()
  const last = new Map<string, bigint>()
  for (const s of input.specs) {
    const c = current(s.contractId)
    if (c === undefined) throw new Error("the organization's nonce could not be read; try again")
    const tip = nonceTip(c)
    const t = taken.get(s.contractId) ?? 0n
    const n = (last.get(s.contractId) ?? (tip > t ? tip : t)) + 1n
    if (isNonceTooFar(c, n)) throw new Error('the organization has too many open requests: finish or decline some first')
    if (!next.has(s.contractId)) next.set(s.contractId, n)
    last.set(s.contractId, n)
  }
  const signer = { keyId: identity.keyId, cid: identity.ceremony.cid, slot: identity.slot }
  const group = newGroupId()
  const platformVersion = sdk.version()
  const proposals: Envelope[] = []
  const approvals: Envelope[] = []
  const ids: string[] = []
  for (const [seq, later] of input.specs.entries()) {
    const spec = specOf(later, ids)
    if (spec.action === 'create') {
      const problem = rc1WriteProblem(opts.forge, spec.contractId, spec.documentType, spec.data)
      if (problem !== null) throw new Error(`refusing this write: ${problem}`)
    }
    const nonce = next.get(spec.contractId) as bigint
    next.set(spec.contractId, nonce + 1n)
    const built = await buildUnsigned(spec, { ownerId: record.orgId, keyId: identity.keyId, nonce, platformVersion })
    ids.push(built.documentId)
    const body: ProposalBody = {
      network: record.network,
      unsigned: built.unsigned,
      signable: built.signable,
      requirements: [{ cid: signer.cid, slot: signer.slot }],
      intent: intentFor(spec, built, { ownerId: record.orgId, nonce, signer }) as ProposalBody['intent'],
      derived: { documentId: built.documentId },
      note: makeNote({ group, seq, of: input.specs.length, title: input.title }),
    }
    const decoded = await decodeUnsigned(built.unsigned)
    const problems = reviewDecoded(decoded, body, { orgId: record.orgId, keyId: identity.keyId, forge: opts.forge, currentNonce: current })
    if (problems.length > 0) throw new Error(`this request would not pass review: ${problems.join('; ')}`)
    const envelope = propose(unlocked.keys, record.room, body)
    proposals.push(envelope)
    approvals.push(sealApprove(unlocked, record.room, state, envelope))
  }
  await postEnvelopes(record.relay, record.room, [...proposals, ...approvals])
  return group
}

function sealApprove(unlocked: Unlocked, room: string, state: RoomState, proposal: Envelope): Envelope {
  return sealEnvelope(unlocked.keys, room, 'approve', { proposalId: envelopeId(proposal), shares: approveBody(unlocked.seed, unlocked.keys, state, proposal.body as unknown as ProposalBody) })
}

export async function signRequest(sdk: EvoSDK, view: OrgView, request: RequestView, unlocked: Unlocked, opts: LoadOptions): Promise<RequestView | null> {
  const { record, state } = view
  assert(unlocked.keys.authPub === record.authPub, 'unlock with your multisig seed phrase first')
  if (request.request.malformed) throw new Error('The parts of this request do not fit together.')
  if (request.status !== 'collecting' && request.status !== 'ready') throw new Error('this request is no longer open for signatures')
  const problems = request.proposals.flatMap((p) => p.problems)
  if (problems.length > 0) throw new Error(problems[0])
  const pending = request.request.proposals.filter((p) => p.status !== 'executed' && !Object.hasOwn(p.approvals, unlocked.keys.authPub))
  const envelopes = pending.map((p) => sealEnvelope(unlocked.keys, record.room, 'approve', { proposalId: p.id, shares: approveBody(unlocked.seed, unlocked.keys, state, p.body) }))
  if (envelopes.length > 0) await postEnvelopes(record.relay, record.room, envelopes)
  const after = await loadOrg(sdk, record, opts)
  const now = after.requests.find((r) => r.request.id === request.request.id) ?? null
  if (now?.status === 'ready') return finishRequest(sdk, after, now, unlocked, opts)
  return now
}

export async function declineRequest(view: OrgView, request: RequestView, unlocked: Unlocked, reason = ''): Promise<void> {
  const { record } = view
  assert(unlocked.keys.authPub === record.authPub, 'unlock with your multisig seed phrase first')
  const envelopes = request.request.proposals.filter((p) => p.status !== 'executed').map((p) => reject(unlocked.keys, record.room, p.id, reason))
  await postEnvelopes(record.relay, record.room, envelopes)
}

export async function finishRequest(sdk: EvoSDK, view: OrgView, request: RequestView, unlocked: Unlocked, opts: LoadOptions): Promise<RequestView | null> {
  const { record, state, identity } = view
  const key = requirementKey({ cid: identity.ceremony.cid, slot: identity.slot })
  for (const [i, p] of request.request.proposals.entries()) {
    const pv = request.proposals[i] as ProposalView
    const d = pv.decoded
    if (p.status === 'executed' || d === null) continue
    if (pv.done) {
      await postEnvelopes(record.relay, record.room, [recordBroadcast(unlocked.keys, record.room, p.id, { ok: true, confirmed: true })])
      continue
    }
    if (p.status !== 'ready') break
    const signature = combine(state, p.id)[key]
    assert(signature, 'the shares do not combine')
    try {
      const st = await signedTransition(p.body.unsigned, signature.signature)
      await broadcastPresigned(sdk, st, {
        identityId: record.orgId,
        contractId: d.contractId,
        documentType: d.documentType,
        documentId: d.documentId,
        action: d.action as 'create' | 'replace' | 'delete',
        ...(d.revision !== null ? { revision: d.revision } : {}),
        nonce: d.nonce,
      })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      await postEnvelopes(record.relay, record.room, [recordBroadcast(unlocked.keys, record.room, p.id, { ok: false, error: error.slice(0, 300) })]).catch(() => undefined)
      throw e
    }
    await postEnvelopes(record.relay, record.room, [recordBroadcast(unlocked.keys, record.room, p.id, { ok: true, confirmed: true })])
  }
  const after = await loadOrg(sdk, record, opts)
  return after.requests.find((r) => r.request.id === request.request.id) ?? null
}

export function memberOf(view: OrgView, authPub: string): boolean {
  return participantIndex(view.identity.ceremony.config, authPub) !== null
}
