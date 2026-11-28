import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Encode } from '../auth/base58'
import type { Network } from '../constants'
import type { ForgeIds } from '../deployments'
import { rc1WriteProblem } from '../layout'
import { DOC } from '../repo/contract'
import { authSdk } from '../sdk/facade'
import { isNonceSpent, isNonceTooFar, nonceTip } from '../sdk/nonce'
import { broadcastPresigned, type WriteAuth } from '../sdk/write'
import { resolveDpnsName } from '../view/dpns'
import { shortIdentity } from '../view/format'
import { signShare } from './bls'
import { describeTransition } from './describe'
import { envelopeId, sealEnvelope, type Envelope } from './envelope'
import { findOrgIdentity, groupKeyEnabled, type OrgIdentity } from './identity'
import { RELAY_ORIGIN } from './gate'
import { parseInvite, roomOnNetwork } from './invite'
import { combine, propose, recordBroadcast, recoverShares, reject } from './participant'
import { MEMBER_IDENTITIES_PER_KEY, encodeMessage, mergeLogs, memberIdentities, openShare, reassemble, sealShare, signMemberProof, type MemberRow, type MessageRow } from './platform'
import { pullRoom } from './relay'
import {
  cardState,
  declinedBy,
  declinedOut,
  goneCreate,
  groupRequests,
  partWrite,
  makeNote,
  newGroupId,
  proposalDone,
  refusalReasons,
  refusedText,
  requestId,
  requestStatus,
  sharesCollected,
  signedBy,
  type CardState,
  type OrgRequest,
  type PartWrite,
  type ProposalFacts,
  type RequestStatus,
} from './requests'
import { memberIndex, rosterCeremony, rosterFromDoc, rosterFromIdentity, shareMatches, type Roster } from './roster'
import { reduce, requirementKey, type ProposalBody, type RoomState } from './state'
import { cacheCeremony, cachedCeremony, saveOrg, type OrgMember, type OrgRecord, type Unlocked } from './store'
import { buildUnsigned, decodeUnsigned, derivedFor, intentFor, nonceProblem, reviewDecoded, signedTransition, type DecodedTransition, type ReviewContext, type WriteSpec } from './transition'
import { OrgUnavailableError, orgContractOf, platformOrgPort, type OrgPort } from './transport'
import { assert, hex, unhex } from './util'
import { memberChangeProblem } from './actions'

interface Facades {
  identities: { contractNonce(identityId: string, contractId: string): Promise<bigint | undefined> }
  documents: { get(contractId: string, type: string, id: string): Promise<{ revision?: bigint; toObject(): Record<string, unknown> } | undefined | null> }
}
const facades = (sdk: EvoSDK): Facades => sdk as unknown as Facades

const CEREMONY_TYPES: ReadonlySet<string> = new Set(['hello', 'config', 'accept', 'dkg-commit', 'dkg-reveal', 'dkg-complete', 'dkg-complaint'])

const ceremonyStates = new Map<string, RoomState>()
const messageLogs = new Map<string, MessageRow[]>()
const decodes = new Map<string, Promise<DecodedTransition | null>>()
const memberNames = new Map<string, string>()

export function orgPortFor(sdk: EvoSDK, forge: ForgeIds): OrgPort {
  const contract = orgContractOf(forge)
  if (contract === null) throw new OrgUnavailableError()
  return platformOrgPort(sdk, contract)
}

const ceremonyOnly = (messages: readonly unknown[]): unknown[] =>
  messages.filter((m) => typeof (m as { type?: unknown })?.type === 'string' && CEREMONY_TYPES.has((m as { type: string }).type))

export interface ConnectCandidate {
  readonly invite: { readonly room: string; readonly relay: string; readonly label: string | null }
  readonly identity: OrgIdentity
  readonly label: string
  readonly threshold: number
  readonly members: readonly (OrgMember & { readonly fingerprint: string })[]
  readonly ceremony: readonly unknown[]
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
  const ceremony = ceremonyOnly((await pullRoom(invite.relay, invite.room)).messages)
  const state = reduce(ceremony, { room: invite.room })
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
    ceremony,
  }
}

/**
 * Connect: the phrase picks the member; the signed-in identity's `orgMember` (with its sealed
 * share) is written unless it already has one for this organization (§10.5). The ceremony is kept
 * in this browser and the organization is remembered here.
 */
export async function connect(
  sdk: EvoSDK,
  candidate: ConnectCandidate,
  network: string,
  unlocked: Unlocked,
  auth: WriteAuth,
  opts: { readonly forge: ForgeIds; readonly port?: OrgPort },
): Promise<OrgRecord> {
  const me = candidate.members.find((m) => m.authPub === unlocked.keys.authPub)
  if (!me) throw new ConnectError(`This seed phrase isn't one of ${candidate.label}'s members.`)
  const port = opts.port ?? orgPortFor(sdk, opts.forge)
  const orgId = candidate.identity.orgId
  const roster = rosterFromIdentity(candidate.identity, candidate.invite.relay)
  const state = reduce(candidate.ceremony, { room: candidate.invite.room })
  await ensureMembership(port, auth, network, roster, unlocked, state)
  const record: OrgRecord = {
    network,
    orgId,
    room: candidate.invite.room,
    relay: candidate.invite.relay,
    authPub: me.authPub,
    label: candidate.label,
    threshold: candidate.threshold,
    members: candidate.members.map(({ index, name, authPub: a }) => ({ index, name, authPub: a })),
    identityId: auth.identityId,
  }
  cacheCeremony(network, orgId, candidate.ceremony)
  ceremonyStates.set(orgId, state)
  saveOrg(record)
  return record
}

/**
 * The signed-in identity's `orgMember` (written when it has none for the organization) and its
 * `orgShare` for the roster's ceremony (written when it has none and the ceremony is kept here).
 */
async function ensureMembership(port: OrgPort, auth: WriteAuth, network: string, roster: Roster, unlocked: Unlocked, state: RoomState | null, intent?: string): Promise<void> {
  const key = unlocked.keys.authPub
  const memberKey = `${roster.orgId}|${auth.identityId}|${key}`
  const shareKey = `${roster.orgId}|${auth.identityId}|${roster.cid}`
  if (written.has(memberKey) && (written.has(shareKey) || state?.ceremonies[roster.cid]?.status !== 'complete')) return
  const mine = (await port.membershipsOf(auth.identityId)).filter((r) => r.org === roster.orgId).map((r) => hex(r.authPub))
  const needsMember = !mine.includes(key) && !written.has(memberKey)
  if (needsMember && mine.some((k) => roster.members.includes(k))) {
    throw new ConnectError('This Forge identity is already connected to this organization as another member. Sign in with the identity you connected with.')
  }
  const shareHeld = written.has(shareKey) || (await port.shareOf(roster.orgId, auth.identityId, roster.cid)) !== null
  const canSeal = !shareHeld && state?.ceremonies[roster.cid]?.status === 'complete'
  const sealed = canSeal ? checkedSeal(unlocked, network, roster, state as RoomState) : null
  if (needsMember) {
    const proof = signMemberProof(unlocked.keys.authSecret, network, roster.orgId, auth.identityId)
    await port.writeMember(auth, { org: roster.orgId, room: roster.room, authPub: unhex(key), proof }, intent)
  }
  written.add(memberKey)
  if (sealed) await port.writeShare(auth, { org: roster.orgId, cid: unhex(roster.cid), sealed }, intent)
  if (sealed || shareHeld) written.add(shareKey)
}

/**
 * The member's share sealed for `orgShare`, opened again and checked against their public share in
 * the ceremony and the roster before anything is written: an `orgShare` can never be replaced.
 */
function checkedSeal(unlocked: Unlocked, network: string, roster: Roster, state: RoomState): Uint8Array | null {
  const share = recoverShares(unlocked.seed, unlocked.keys, state, roster.cid).shares[roster.slot]
  const index = memberIndex(roster, unlocked.keys.authPub)
  if (share === undefined || index === null) return null
  const sealed = sealShare(unlocked.seed, network, roster.orgId, roster.cid, share)
  if (openShare(unlocked.seed, network, roster.orgId, roster.cid, sealed) !== share || !shareMatches(roster, index, share)) {
    throw new ConnectError("Your share of the organization's key doesn't check out against its published keys, so Forge wrote nothing. Check the phrase, or ask the members to publish the organization again.")
  }
  return sealed
}

/** The organizations the signed-in identity's `orgMember` documents name, as records (§10.5). */
export async function membershipRecords(port: OrgPort, identityId: string, network: string): Promise<OrgRecord[]> {
  const byOrg = new Map<string, MemberRow[]>()
  for (const r of (await port.membershipsOf(identityId)).sort((a, b) => b.createdAt - a.createdAt)) byOrg.set(r.org, [...(byOrg.get(r.org) ?? []), r])
  return [...byOrg.values()].map((rows) => {
    const newest = rows[0] as MemberRow
    return { network, orgId: newest.org, room: newest.room, relay: RELAY_ORIGIN, authPub: hex(newest.authPub), label: '', threshold: 0, members: [], identityId, boundKeys: rows.map((r) => hex(r.authPub)) }
  })
}

async function keyEnabled(sdk: EvoSDK, orgId: string, keyId: number, groupKey: string): Promise<boolean> {
  const identity = await authSdk(sdk).identities.fetch(orgId)
  if (!identity) return false
  try {
    return groupKeyEnabled(identity, keyId, groupKey)
  } finally {
    ;(identity as { free?: () => void }).free?.()
  }
}

/**
 * The roster (§10.2): the organization's `org` document while its group key is the identity's
 * enabled key, else the ceremony kept in this browser, else the ceremony read from the relay.
 */
async function loadRoster(sdk: EvoSDK, port: OrgPort, record: OrgRecord): Promise<Roster> {
  const doc = await port.orgDoc(record.orgId)
  let state = ceremonyStates.get(record.orgId) ?? null
  const fromDoc = doc ? rosterFromDoc(record.orgId, doc.fields) : null
  if (fromDoc && (await keyEnabled(sdk, record.orgId, fromDoc.keyId, fromDoc.groupKey))) {
    if (state === null) {
      const cached = cachedCeremony(record.network, record.orgId)
      if (cached) state = reduce(cached, { room: fromDoc.room })
    }
    const c = state?.ceremonies[fromDoc.cid]
    const named = c?.status === 'complete' ? { label: c.config.label, names: fromDoc.members.map((a) => c.config.participants.find((p) => p.authPub === a)?.name ?? '') } : {}
    return { ...fromDoc, ...named }
  }
  if (state === null) {
    let messages = cachedCeremony(record.network, record.orgId)
    if (messages === null) {
      messages = ceremonyOnly((await pullRoom(record.relay, record.room)).messages)
      cacheCeremony(record.network, record.orgId, messages)
    }
    state = reduce(messages, { room: record.room })
  }
  ceremonyStates.set(record.orgId, state)
  const found = await findOrgIdentity(sdk, state)
  if (found === null || found.orgId !== record.orgId) throw new Error("This group's keys no longer control the organization's identity. Reconnect it from its invite.")
  return rosterFromIdentity(found, record.relay)
}

async function readLog(port: OrgPort, orgId: string, ownerId: string): Promise<MessageRow[]> {
  const key = `${orgId}|${ownerId}`
  const known = messageLogs.get(key) ?? []
  const since = known.reduce((m, r) => Math.max(m, r.createdAt), 0)
  const fresh = await port.messagesOf(orgId, ownerId, since)
  const ids = new Set(known.map((r) => r.id))
  const all = [...known, ...fresh.filter((r) => !ids.has(r.id))]
  messageLogs.set(key, all)
  return all
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
  /** A create reported done whose document is no longer on Platform. */
  readonly gone: boolean
  readonly nonceUnread: boolean
  /** It can never land, so it holds no nonce (§9). */
  readonly superseded: boolean
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
  readonly roster: Roster
  readonly state: RoomState
  readonly members: readonly MemberRow[]
  readonly requests: readonly RequestView[]
  /** Members whose messages could not be read this time: their signatures may be missing. */
  readonly unreadLogs: number
  /** None of this member's bound keys is in the current roster: connect again from the new invite. */
  readonly reconnect: boolean
}

export interface LoadOptions {
  readonly network: Network
  readonly forge: ForgeIds
  readonly describe?: boolean
  readonly port?: OrgPort
}

function nameOf(roster: Roster, members: readonly MemberRow[], authPub: string): string {
  const index = memberIndex(roster, authPub)
  if (index === null) return 'Someone outside the organization'
  const given = roster.names[index - 1]
  if (given) return given
  const identity = members.find((m) => hex(m.authPub) === authPub)
  const dpns = identity ? memberNames.get(identity.ownerId) : undefined
  return dpns ?? `Member ${index}`
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

const landedParts = new Set<string>()
const doneSentences = new Map<string, string>()

/** Whether a part's write is visible on Platform (§11.6); undefined when the read failed. Once seen, kept for the tab. */
async function writtenOnChain(sdk: EvoSDK, proposalId: string, d: DecodedTransition, spent: boolean, claimed: boolean): Promise<PartWrite | undefined> {
  if (landedParts.has(proposalId)) return { landed: true, superseded: false, absent: d.action === 'delete' }
  try {
    const doc = await storedDoc(sdk, d.contractId, d.documentType, d.documentId)
    const stored = doc && { revision: doc.revision, fields: doc.data }
    const seen = partWrite(d.action, stored, { revision: d.revision, fields: d.data }, spent, claimed)
    if (seen.landed) landedParts.add(proposalId)
    return seen
  } catch {
    return undefined
  }
}

const reviewContext = (record: OrgRecord, roster: Roster, forge: ForgeIds, currentNonce: (contractId: string) => bigint | undefined): ReviewContext => ({
  orgId: record.orgId,
  keyId: roster.keyId,
  forge,
  currentNonce,
  orgContract: orgContractOf(forge),
  roster,
  network: record.network,
})

export async function loadOrg(sdk: EvoSDK, record: OrgRecord, opts: LoadOptions): Promise<OrgView> {
  const port = opts.port ?? orgPortFor(sdk, opts.forge)
  const roster = await loadRoster(sdk, port, record)
  const viewerKey = [record.authPub, ...(record.boundKeys ?? [])].find((k) => roster.members.includes(k)) ?? null
  const bound = (rows: readonly MemberRow[], a: string): MemberRow[] => memberIdentities(rows, record.network, record.orgId, [a])
  const rowsByKey = await Promise.all(roster.members.map((a) => port.membersByKey(record.orgId, a, (rows) => bound(rows, a).length >= MEMBER_IDENTITIES_PER_KEY)))
  const members = memberIdentities(rowsByKey.flat(), record.network, record.orgId, roster.members)
  const read = await Promise.allSettled(members.map(async (m) => reassemble(await readLog(port, record.orgId, m.ownerId), roster.room, hex(m.authPub))))
  const logs = read.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  const unreadLogs = new Set(members.filter((_, i) => read[i]?.status === 'rejected').map((m) => hex(m.authPub))).size
  const { envelopes, carriedAt } = mergeLogs(logs, envelopeId)
  const state = reduce(envelopes, { room: roster.room, ceremonies: [rosterCeremony(roster)], carriedAt })
  const requests = groupRequests(state, roster.cid)
  const decoded = new Map<string, DecodedTransition | null>()
  await Promise.all(requests.flatMap((r) => r.proposals.map(async (p) => decoded.set(p.id, await decodeCached(p.body.unsigned)))))
  const currentNonce = await nonceReader(
    sdk,
    record.orgId,
    [...decoded.values()].filter((d): d is DecodedTransition => d !== null && d.contractId !== '').map((d) => d.contractId),
  )
  const ctx = reviewContext(record, roster, opts.forge, currentNonce)
  const parts = requests.flatMap((r) => r.proposals.map((p, i) => ({ r, p, i, d: decoded.get(p.id) ?? null })))
  const visible = new Map<string, PartWrite | undefined>()
  await Promise.all(
    parts.map(async ({ p, d }) => {
      const current = d ? currentNonce(d.contractId) : undefined
      visible.set(p.id, d === null ? { landed: false, superseded: false, absent: false } : await writtenOnChain(sdk, p.id, d, current !== undefined && isNonceSpent(current, d.nonce), p.status === 'executed'))
    }),
  )
  const landedBy = new Map<string, { readonly request: string; readonly signable: string }[]>()
  for (const { r, p, d } of parts) {
    if (!d || visible.get(p.id)?.landed !== true) continue
    const slot = `${d.contractId}:${d.nonce}`
    landedBy.set(slot, [...(landedBy.get(slot) ?? []), { request: r.id, signable: d.signable }])
  }
  const facts = new Map<string, ProposalFacts>()
  for (const { r, p, i, d } of parts) {
    const slot = d ? `${d.contractId}:${d.nonce}` : null
    const reused = slot !== null && r.proposals.slice(0, i).some((q) => {
      const e = decoded.get(q.id)
      return e !== null && e !== undefined && `${e.contractId}:${e.nonce}` === slot
    })
    const current = d ? currentNonce(d.contractId) : undefined
    const spent = d !== null && current !== undefined && isNonceSpent(current, d.nonce)
    const seen = visible.get(p.id)
    const nonceUnread = d !== null && current === undefined
    const takenByOther = slot !== null && d !== null && (landedBy.get(slot) ?? []).some((x) => x.request !== r.id && x.signable !== d.signable)
    const onChain = seen?.landed === true && !takenByOther
    const gone = d !== null && goneCreate(d.action, p.status === 'executed', spent, seen?.absent, takenByOther)
    const superseded = seen?.superseded === true
    const problems = d === null ? ['its transition cannot be read'] : [...reviewDecoded(d, p.body, ctx), ...(reused ? ['it uses the same nonce as another part of this request'] : [])]
    facts.set(p.id, { reviewProblems: problems, nonceProblem: d && current !== undefined && !spent ? nonceProblem(d, current) : null, nonceUnread, nonce: d?.nonce ?? null, contractId: d?.contractId ?? null, spent: spent || takenByOther, onChain, gone, superseded })
  }
  await resolveMemberNames(sdk, members, opts.network)
  const enriched: OrgRecord = {
    ...record,
    authPub: viewerKey ?? record.authPub,
    room: roster.room,
    label: record.label || roster.label || shortIdentity(record.orgId),
    threshold: roster.threshold,
    members: roster.members.map((a, i) => ({ index: i + 1, name: nameOf(roster, members, a), authPub: a })),
  }
  const memberSet = new Set(roster.members)
  const names = new Map<string, string>()
  const repoNames = new Map<string, string | null>()
  const views: RequestView[] = []
  for (const r of requests) {
    const status = requestStatus(r, (id) => facts.get(id), declinedOut(r, memberSet, roster.threshold))
    const proposals: ProposalView[] = []
    for (const p of r.proposals) {
      const d = decoded.get(p.id) ?? null
      const f = facts.get(p.id)
      let sentence = 'An action Forge cannot read'
      if (d !== null && opts.describe !== false) {
        sentence = doneSentences.get(p.id) ?? (await describe(sdk, d, enriched, opts, names, repoNames))
        if (proposalDone(f)) doneSentences.set(p.id, sentence)
      }
      proposals.push({ id: p.id, decoded: d, problems: f?.reviewProblems ?? [], sentence, done: proposalDone(f), gone: f?.gone === true, nonceUnread: f?.nonceUnread === true, superseded: f?.superseded === true })
    }
    const collected = sharesCollected(r, roster.cid, roster.slot)
    const viewerSigned = signedBy(r, enriched.authPub)
    const viewerDeclined = declinedBy(r, enriched.authPub)
    const signerKeys = new Set(r.proposals.flatMap((p) => Object.keys(p.approvals)))
    const declinerKeys = new Set(r.proposals.flatMap((p) => Object.keys(p.rejections)))
    views.push({
      request: r,
      status,
      card: cardState(status, collected, roster.threshold, viewerSigned, status === 'invalid' ? refusalReasons(r, (id) => facts.get(id)) : [], roster.members.length),
      proposals,
      collected,
      needed: roster.threshold,
      proposer: nameOf(roster, members, r.from),
      signers: [...signerKeys].map((k) => nameOf(roster, members, k)),
      decliners: [...declinerKeys].map((k) => nameOf(roster, members, k)),
      viewerSigned,
      viewerDeclined,
    })
  }
  return { record: enriched, roster, state, members, requests: views, unreadLogs, reconnect: viewerKey === null }
}

async function resolveMemberNames(sdk: EvoSDK, members: readonly MemberRow[], network: Network): Promise<void> {
  await Promise.all(
    members
      .filter((m) => !memberNames.has(m.ownerId))
      .map(async (m) => {
        const name = await resolveDpnsName(sdk, m.ownerId, network).catch(() => null)
        if (name) memberNames.set(m.ownerId, name)
      }),
  )
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
  const repoIds = [source['repoId'], d.data['renamedTo']].filter((v): v is Uint8Array => v instanceof Uint8Array).map(base58Encode)
  if (memberId) ids.add(memberId)
  await Promise.all(
    [...ids].filter((id) => !names.has(id)).map(async (id) => names.set(id, (await resolveDpnsName(sdk, id, opts.network)) ?? shortIdentity(id))),
  )
  for (const repoId of repoIds.filter((id) => !repoNames.has(id))) {
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

export function requestLink(orgId: string, id: string): string {
  return `/org/?id=${encodeURIComponent(orgId)}&request=${encodeURIComponent(id)}`
}

/**
 * The nonces per contract that the organization's requests hold: every proposal a member made
 * that the room accepted and that writes as the organization, whatever its request's status (a
 * landed nonce is at or below the tip, below anything handed out; a later part of an overtaken
 * request keeps its nonce until the tip passes it). A request still collecting that enough
 * members declined, without approving, holds none. dg holds by the same rule (`Org::open_nonces`).
 */
function openNonces(view: OrgView): Map<string, Set<bigint>> {
  const held = new Map<string, Set<bigint>>()
  const members = new Set(view.roster.members)
  for (const r of view.requests) {
    if (declinedOut(r.request, members, view.roster.threshold)) continue
    for (const [i, p] of r.request.proposals.entries()) {
      const d = r.proposals[i]?.decoded
      if (!d || p.status === 'invalid' || r.proposals[i]?.superseded || !members.has(p.from) || d.ownerId !== view.record.orgId) continue
      const set = held.get(d.contractId) ?? new Set<bigint>()
      set.add(d.nonce)
      held.set(d.contractId, set)
    }
  }
  return held
}

/**
 * A nonce per write: the lowest ones above the tip that no open request holds. Platform accepts
 * nonces out of order within its window, so one request holding a far nonce blocks nothing.
 */
export function freeNonces(contracts: readonly string[], current: (contractId: string) => bigint | undefined, held: ReadonlyMap<string, ReadonlySet<bigint>>): bigint[] {
  const last = new Map<string, bigint>()
  return contracts.map((contractId) => {
    const c = current(contractId)
    if (c === undefined) throw new Error("the organization's nonce could not be read; try again")
    let n = (last.get(contractId) ?? nonceTip(c)) + 1n
    while (held.get(contractId)?.has(n)) n += 1n
    if (isNonceTooFar(c, n)) throw new Error("the organization's open requests hold every nonce Platform accepts: finish some first")
    last.set(contractId, n)
    return n
  })
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

export interface MyShare {
  readonly index: number
  readonly share: bigint
}

/**
 * The member's share of the organization's key: from the ceremony kept here, else from the
 * `orgShare` one of their Forge identities sealed for this ceremony.
 */
export async function myShare(port: OrgPort, view: OrgView, unlocked: Unlocked, identityId: string): Promise<MyShare> {
  const { roster } = view
  const index = memberIndex(roster, unlocked.keys.authPub)
  assert(index !== null, "this seed phrase isn't one of the organization's members")
  const state = ceremonyStates.get(roster.orgId)
  let share: bigint | null = null
  if (state?.ceremonies[roster.cid]?.status === 'complete') share = recoverShares(unlocked.seed, unlocked.keys, state, roster.cid).shares[roster.slot] ?? null
  const owners = [identityId, ...view.members.filter((m) => hex(m.authPub) === unlocked.keys.authPub && m.ownerId !== identityId).map((m) => m.ownerId)]
  for (const owner of owners) {
    if (share !== null) break
    const row = await port.shareOf(roster.orgId, owner, roster.cid)
    if (row) share = openShare(unlocked.seed, view.record.network, roster.orgId, roster.cid, row.sealed)
  }
  assert(share !== null, "Forge can't find your share of the organization's key. Connect the organization again from its invite.")
  assert(shareMatches(roster, index, share), "your share does not match the organization's key (wrong seed phrase?)")
  return { index, share }
}

export function approveEnvelope(view: OrgView, unlocked: Unlocked, mine: MyShare, proposalId: string, body: ProposalBody): Envelope {
  const { roster } = view
  const req = body.requirements.find((r) => r.cid === roster.cid && r.slot === roster.slot)
  assert(req, 'you hold no share for any key this proposal needs')
  return sealEnvelope(unlocked.keys, roster.room, 'approve', { proposalId, shares: { [requirementKey(req)]: { index: mine.index, share: signShare(mine.share, unhex(body.signable)) } } })
}

async function post(view: OrgView, opts: ActOptions & { readonly port: OrgPort }, unlocked: Unlocked, envelopes: readonly Envelope[]): Promise<void> {
  const messages = envelopes.map(encodeMessage)
  await ensureMembership(opts.port, opts.auth, view.record.network, view.roster, unlocked, ceremonyStates.get(view.roster.orgId) ?? null, opts.intent)
  const posted = new Set((messageLogs.get(`${view.roster.orgId}|${opts.auth.identityId}`) ?? []).map((r) => `${hex(r.digest)}:${r.part}`))
  for (const parts of messages) {
    const missing = parts.filter((p) => !posted.has(`${hex(p.digest)}:${p.part}`))
    if (missing.length > 0) await opts.port.writeMessage(opts.auth, view.roster.orgId, missing, opts.intent)
  }
}

const builtEnvelopes = new Map<string, readonly Envelope[]>()

/** The envelopes of one confirmed action: a retry with the same intent posts the very same ones. */
function sameEnvelopes(intent: string | undefined, key: string, build: () => Envelope[]): readonly Envelope[] {
  if (intent === undefined) return build()
  const k = `${intent}|${key}`
  const held = builtEnvelopes.get(k)
  if (held) return held
  const made = build()
  builtEnvelopes.set(k, made)
  return made
}

export interface ActOptions extends LoadOptions {
  readonly auth: WriteAuth
  /** The confirmed action (ConfirmDialog's intent): a retry posts the same messages again, never new ones. */
  readonly intent?: string
}

const written = new Set<string>()
const builtRequests = new Map<string, { readonly id: string; readonly envelopes: readonly Envelope[] }>()

function assertNonceRead(request: RequestView): void {
  if (request.proposals.some((p) => !p.done && p.nonceUnread)) throw new Error("the organization's nonce could not be read; try again in a moment")
}

export async function createRequest(sdk: EvoSDK, record: OrgRecord, unlocked: Unlocked, input: CreateRequestInput, opts: ActOptions): Promise<string> {
  assert(input.specs.length > 0, 'nothing to request')
  const port = opts.port ?? orgPortFor(sdk, opts.forge)
  const act = { ...opts, port }
  const view = await loadOrg(sdk, record, { ...act, describe: false })
  assert(!view.reconnect && unlocked.keys.authPub === view.record.authPub, 'unlock with your multisig seed phrase first')
  if (view.unreadLogs > 0) throw new Error("some members' messages could not be read just now, so their open requests can't be counted; try again in a moment")
  const again = opts.intent === undefined ? undefined : builtRequests.get(opts.intent)
  if (again) {
    await post(view, act, unlocked, again.envelopes)
    builtRequests.delete(opts.intent as string)
    return again.id
  }
  const { roster } = view
  const current = await nonceReader(sdk, record.orgId, input.specs.map((s) => s.contractId))
  const nonces = freeNonces(
    input.specs.map((s) => s.contractId),
    current,
    openNonces(view),
  )
  const signer = { keyId: roster.keyId, cid: roster.cid, slot: roster.slot }
  const group = newGroupId()
  const platformVersion = sdk.version()
  const ctx = reviewContext(record, roster, opts.forge, current)
  const mine = await myShare(port, view, unlocked, opts.auth.identityId)
  const envelopes: Envelope[] = []
  const ids: string[] = []
  for (const [seq, later] of input.specs.entries()) {
    const spec = specOf(later, ids)
    if (spec.action === 'create') {
      const problem = rc1WriteProblem(opts.forge, spec.contractId, spec.documentType, spec.data)
      if (problem !== null) throw new Error(`refusing this write: ${problem}`)
    }
    const nonce = nonces[seq] as bigint
    const built = await buildUnsigned(spec, { ownerId: record.orgId, keyId: roster.keyId, nonce, platformVersion })
    ids.push(built.documentId)
    const body: ProposalBody = {
      network: record.network,
      unsigned: built.unsigned,
      signable: built.signable,
      requirements: [{ cid: signer.cid, slot: signer.slot }],
      intent: intentFor(spec, built, { ownerId: record.orgId, nonce, signer }) as ProposalBody['intent'],
      derived: derivedFor(spec, built),
      note: makeNote({ group, seq, of: input.specs.length, title: input.title }),
    }
    const decoded = await decodeUnsigned(built.unsigned)
    const problems = [...reviewDecoded(decoded, body, ctx), nonceProblem(decoded, current(decoded.contractId) ?? 0n)].filter((p): p is string => typeof p === 'string')
    if (problems.length > 0) throw new Error(`this request would not pass review: ${problems.join('; ')}`)
    const proposal = propose(unlocked.keys, roster.room, body)
    envelopes.push(proposal, approveEnvelope(view, unlocked, mine, envelopeId(proposal), body))
  }
  const id = requestId(group, unlocked.keys.authPub)
  if (opts.intent !== undefined) builtRequests.set(opts.intent, { id, envelopes })
  await post(view, act, unlocked, envelopes)
  if (opts.intent !== undefined) builtRequests.delete(opts.intent)
  return id
}

/** §11.4: a member change on a repository that now has members-only content or environments is refused. */
async function recheckMemberChanges(sdk: EvoSDK, view: OrgView, request: RequestView, forge: ForgeIds): Promise<void> {
  for (const p of request.proposals) {
    if (p.done || p.decoded === null) continue
    const problem = await memberChangeProblem(sdk, forge, view.record.orgId, p.decoded)
    if (problem) throw new Error(problem)
  }
}

export async function signRequest(sdk: EvoSDK, view: OrgView, request: RequestView, unlocked: Unlocked, opts: ActOptions): Promise<RequestView | null> {
  const { record } = view
  assert(unlocked.keys.authPub === record.authPub, 'unlock with your multisig seed phrase first')
  if (request.card.kind === 'invalid') throw new Error(refusedText(request.card.reasons))
  if (request.status !== 'collecting' && request.status !== 'ready') throw new Error('this request is no longer open for signatures')
  assertNonceRead(request)
  await recheckMemberChanges(sdk, view, request, opts.forge)
  const port = opts.port ?? orgPortFor(sdk, opts.forge)
  const pending = request.request.proposals.filter((p, i) => !request.proposals[i]?.done && !Object.hasOwn(p.approvals, unlocked.keys.authPub))
  if (pending.length > 0) {
    const mine = await myShare(port, view, unlocked, opts.auth.identityId)
    await post(view, { ...opts, port }, unlocked, sameEnvelopes(opts.intent, `sign:${request.request.id}`, () => pending.map((p) => approveEnvelope(view, unlocked, mine, p.id, p.body))))
  }
  const after = await loadOrg(sdk, record, { ...opts, port })
  const now = after.requests.find((r) => r.request.id === request.request.id) ?? null
  if (now?.status === 'ready') return finishRequest(sdk, after, now, unlocked, { ...opts, port })
  return now
}

export async function declineRequest(sdk: EvoSDK, view: OrgView, request: RequestView, unlocked: Unlocked, opts: ActOptions, reason = ''): Promise<void> {
  const { record } = view
  assert(unlocked.keys.authPub === record.authPub, 'unlock with your multisig seed phrase first')
  const port = opts.port ?? orgPortFor(sdk, opts.forge)
  const envelopes = sameEnvelopes(opts.intent, `decline:${request.request.id}`, () => request.request.proposals.filter((_, i) => !request.proposals[i]?.done).map((p) => reject(unlocked.keys, view.roster.room, p.id, reason)))
  await post(view, { ...opts, port }, unlocked, envelopes)
}

export async function finishRequest(sdk: EvoSDK, view: OrgView, request: RequestView, unlocked: Unlocked, opts: ActOptions): Promise<RequestView | null> {
  const { record, state, roster } = view
  if (request.request.malformed) throw new Error('The parts of this request do not fit together.')
  if (request.status !== 'ready') throw new Error('this request is not ready to finish')
  assertNonceRead(request)
  await recheckMemberChanges(sdk, view, request, opts.forge)
  const port = opts.port ?? orgPortFor(sdk, opts.forge)
  assert(unlocked.keys.authPub === record.authPub, 'unlock with your multisig seed phrase first')
  const note = (proposalId: string, result: Record<string, unknown>): Promise<void> => post(view, { ...opts, port }, unlocked, sameEnvelopes(opts.intent, `broadcast:${proposalId}:${String(result['ok'])}`, () => [recordBroadcast(unlocked.keys, roster.room, proposalId, result)]))
  const key = requirementKey({ cid: roster.cid, slot: roster.slot })
  for (const [i, p] of request.request.proposals.entries()) {
    const pv = request.proposals[i] as ProposalView
    const d = pv.decoded
    if (d === null || pv.done) continue
    if (p.status !== 'ready' && p.status !== 'executed') break
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
        ...(d.revision !== null ? { revision: d.revision, data: d.data } : {}),
        nonce: d.nonce,
      })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      await note(p.id, { ok: false, error: error.slice(0, 300) }).catch(() => undefined)
      throw e
    }
    await note(p.id, { ok: true, confirmed: true })
  }
  const after = await loadOrg(sdk, record, { ...opts, port })
  return after.requests.find((r) => r.request.id === request.request.id) ?? null
}

/** Forget what this tab read (the kept ceremonies, message logs and decodes), as a fresh device would. */
export function resetOrgCaches(): void {
  landedParts.clear()
  doneSentences.clear()
  written.clear()
  builtEnvelopes.clear()
  ceremonyStates.clear()
  messageLogs.clear()
  decodes.clear()
  memberNames.clear()
}
