import type { StateTransition } from '@dashevo/evo-sdk'

import { base58Encode } from '../auth/base58'
import type { ForgeIds } from '../deployments'
import { contractKindOfType } from '../layout'
import { isNonceSpent, isNonceTooFar } from '../sdk/nonce'
import { isDeclaredLink, parseDeclaredOrg } from './gate'
import { rosterMismatch, type Roster } from './roster-fields'
import { hex, isObject, unhex } from './util'

export type DocAction = 'create' | 'replace' | 'delete'

export type WriteSpec =
  | { readonly action: 'create'; readonly contractId: string; readonly documentType: string; readonly data: Record<string, unknown> }
  | { readonly action: 'replace'; readonly contractId: string; readonly documentType: string; readonly documentId: string; readonly revision: bigint; readonly data: Record<string, unknown> }
  | { readonly action: 'delete'; readonly contractId: string; readonly documentType: string; readonly documentId: string }

export interface BuiltTransition {
  readonly unsigned: string
  readonly signable: string
  readonly documentId: string
  readonly entropy: string | null
}

export const ALLOWED: Readonly<Record<string, readonly DocAction[]>> = {
  repo: ['create', 'replace'],
  maintainer: ['create', 'delete'],
  writer: ['create', 'delete'],
  config: ['create'],
  profile: ['create', 'replace'],
  topic: ['create', 'delete'],
  runner: ['create', 'delete'],
  org: ['create', 'replace'],
}

export const isAllowed = (documentType: string, action: string): boolean => (ALLOWED[documentType] ?? []).includes(action as DocAction)

type Sdk = typeof import('@dashevo/evo-sdk')

async function sdkModule(): Promise<Sdk> {
  return import('@dashevo/evo-sdk')
}

export async function buildUnsigned(
  spec: WriteSpec,
  ctx: { readonly ownerId: string; readonly keyId: number; readonly nonce: bigint; readonly platformVersion: number; readonly entropy?: Uint8Array },
): Promise<BuiltTransition> {
  const m = await sdkModule()
  const { ownerId, nonce, platformVersion } = ctx
  let transition: { toDocumentTransition(): unknown }
  let documentId: string
  let entropy: Uint8Array | null = null
  if (spec.action === 'create') {
    entropy = ctx.entropy ?? crypto.getRandomValues(new Uint8Array(32))
    documentId = base58Encode(m.Document.generateId(spec.documentType, ownerId, spec.contractId, entropy, nonce, platformVersion))
    const base = new m.Document({ properties: {}, documentTypeName: spec.documentType, dataContractId: spec.contractId, ownerId, revision: 1n, id: documentId, entropy })
    const document = m.Document.fromObject({ ...base.toObject(), ...spec.data } as Parameters<typeof m.Document.fromObject>[0], platformVersion)
    transition = new m.DocumentCreateTransition({ document, identityContractNonce: nonce, platformVersion } as ConstructorParameters<typeof m.DocumentCreateTransition>[0])
    if (document.id.toBase58() !== documentId) throw new Error('the new id drifted while building the create transition')
  } else if (spec.action === 'replace') {
    documentId = spec.documentId
    const base = new m.Document({ properties: {}, documentTypeName: spec.documentType, dataContractId: spec.contractId, ownerId, revision: spec.revision, id: documentId })
    const document = m.Document.fromObject({ ...base.toObject(), ...spec.data } as Parameters<typeof m.Document.fromObject>[0], platformVersion)
    transition = new m.DocumentReplaceTransition({ document, identityContractNonce: nonce })
  } else {
    documentId = spec.documentId
    const document = new m.Document({ properties: {}, documentTypeName: spec.documentType, dataContractId: spec.contractId, ownerId, id: documentId })
    transition = new m.DocumentDeleteTransition({ document, identityContractNonce: nonce })
  }
  const batch = m.BatchTransition.fromBatchedTransitions([new m.BatchedTransition(transition.toDocumentTransition() as never)], ownerId, 0)
  const st = batch.toStateTransition()
  st.setIdentityContractNonce(nonce)
  st.signaturePublicKeyId = ctx.keyId
  return { unsigned: hex(st.toBytes()), signable: hex(st.getSignableBytes()), documentId, entropy: entropy === null ? null : hex(entropy) }
}

export interface DecodedTransition {
  readonly canonical: boolean
  readonly kind: string
  readonly ownerId: string
  readonly signaturePublicKeyId: number | null
  readonly userFeeIncrease: number
  readonly signatureEmpty: boolean
  readonly signable: string
  readonly count: number
  readonly action: string
  readonly documentType: string
  readonly contractId: string
  readonly documentId: string
  readonly nonce: bigint
  readonly revision: bigint | null
  readonly data: Record<string, unknown>
}

const idString = (v: unknown): string => (v instanceof Uint8Array ? base58Encode(v) : typeof v === 'string' ? v : '')

export async function decodeUnsigned(unsignedHex: string): Promise<DecodedTransition> {
  const m = await sdkModule()
  const bytes = unhex(unsignedHex)
  const st = m.StateTransition.fromBytes(bytes)
  const kind = String(st.actionType)
  if (!kind.startsWith('DocumentsBatch')) {
    return { canonical: false, kind, ownerId: '', signaturePublicKeyId: null, userFeeIncrease: st.userFeeIncrease, signatureEmpty: false, signable: '', count: 0, action: '', documentType: '', contractId: '', documentId: '', nonce: 0n, revision: null, data: {} }
  }
  const batch = m.BatchTransition.fromStateTransition(st).toObject() as unknown as {
    ownerId: Uint8Array
    transitions: Record<string, unknown>[]
    userFeeIncrease: number
    signaturePublicKeyId: number
    signature: Uint8Array
  }
  const t = batch.transitions[0] ?? {}
  const data: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(t)) if (!k.startsWith('$')) data[k] = v
  const revision = t['$revision']
  return {
    canonical: hex(st.toBytes()) === unsignedHex,
    kind,
    ownerId: idString(batch.ownerId),
    signaturePublicKeyId: st.signaturePublicKeyId ?? null,
    userFeeIncrease: st.userFeeIncrease,
    signatureEmpty: (st.signature?.length ?? 0) === 0,
    signable: hex(st.getSignableBytes()),
    count: batch.transitions.length,
    action: t['$transition'] === 'document' ? String(t['$action'] ?? '') : '',
    documentType: String(t['$type'] ?? ''),
    contractId: idString(t['$dataContractId']),
    documentId: idString(t['$id']),
    nonce: BigInt((t['$identityContractNonce'] as bigint | number | undefined) ?? 0),
    revision: typeof revision === 'bigint' || typeof revision === 'number' ? BigInt(revision) : null,
    data,
  }
}

export interface ReviewContext {
  readonly orgId: string
  readonly keyId: number
  readonly forge: ForgeIds
  readonly currentNonce: (contractId: string) => bigint | undefined
  /** forge-org's id, where the `org` roster lives. */
  readonly orgContract?: string | null
  /** What an `org` write and a profile's declared link must match (§10.5). */
  readonly roster?: Roster
  readonly network?: string
}

function contractFor(documentType: string, ctx: ReviewContext): string | null {
  if (documentType === 'org') return ctx.orgContract ?? ctx.forge.org ?? null
  const kind = contractKindOfType(documentType, ctx.forge)
  return kind === null ? null : (ctx.forge[kind] ?? null)
}

/**
 * What review finds wrong with a proposal (§9 steps 1, 2, 3 and 5, §10.5), in dg's words
 * (`forge-core::org::review`); the nonce, step 4, is {@link nonceProblem}'s.
 */
export function reviewDecoded(
  d: DecodedTransition,
  body: { readonly signable: string; readonly network?: string; readonly requirements?: readonly { readonly cid: string; readonly slot: string }[] },
  ctx: ReviewContext,
): string[] {
  const problems: string[] = []
  if (ctx.network !== undefined && body.network !== undefined && body.network !== ctx.network) problems.push(`it is for ${body.network}, not ${ctx.network}`)
  const reqs = body.requirements
  if (ctx.roster && reqs && !(reqs.length === 1 && reqs[0]?.cid === ctx.roster.cid && reqs[0]?.slot === ctx.roster.slot)) problems.push("it asks for signatures from keys other than the organization's")
  // copy-lint-ignore: dg's exact words (forge-core::org::review), shown the same by both clients
  if (!d.kind.startsWith('DocumentsBatch') || d.count !== 1) return [...problems, 'it is not exactly one document write']
  if (!d.canonical) problems.push('its bytes do not re-encode to themselves')
  if (d.ownerId !== ctx.orgId) problems.push('it writes as another identity, not the organization')
  if (d.signaturePublicKeyId !== ctx.keyId) problems.push("it is not signed with the organization's group key")
  if (d.userFeeIncrease !== 0) problems.push('it raises the fee')
  if (!d.signatureEmpty) problems.push('it already carries a signature')
  if (d.signable !== body.signable) problems.push("the bytes to sign are not the transition's")
  if (!isAllowed(d.documentType, d.action)) {
    problems.push(`Forge does not sign this kind of write (${d.action || 'unknown'} ${d.documentType || 'document'})`)
    return problems
  }
  if (contractFor(d.documentType, ctx) !== d.contractId) problems.push("it writes to a contract that is not this network's Forge")
  if (d.documentType === 'org') {
    const mismatch = ctx.roster ? rosterMismatch(ctx.roster, d.data) : null
    if (mismatch) problems.push(mismatch)
  } else if (d.documentType === 'profile' && ctx.roster) {
    const links = Array.isArray(d.data['links']) ? d.data['links'] : []
    const size = ctx.roster.members.length
    for (const link of links.filter(isDeclaredLink)) {
      const declared = parseDeclaredOrg(link, ctx.network ?? '')
      if (!declared || declared.threshold !== ctx.roster.threshold || declared.size !== size) problems.push(`its profile link says something other than ${ctx.roster.threshold} of ${size}`)
    }
  }
  return problems
}


/** Why the organization's nonce state keeps the write from landing, or null (dg's `nonce_problem`). */
export function nonceProblem(d: DecodedTransition, current: bigint): string | null {
  if (isNonceSpent(current, d.nonce)) return 'it was overtaken: its nonce is already used'
  if (isNonceTooFar(current, d.nonce)) return 'its nonce is further ahead than Platform accepts'
  return null
}

export function intentFor(
  spec: WriteSpec,
  built: BuiltTransition,
  ctx: { readonly ownerId: string; readonly nonce: bigint; readonly signer: { keyId: number; cid: string; slot: string } },
): Record<string, unknown> {
  const plain = (v: unknown): unknown =>
    v instanceof Uint8Array ? hex(v) : typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map(plain) : isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v
  const document: Record<string, unknown> = { action: spec.action, documentType: spec.documentType }
  if (spec.action !== 'delete') document['properties'] = plain(spec.data)
  if (spec.action === 'create') document['entropy'] = built.entropy
  if (spec.action !== 'create') document['id'] = spec.documentId
  if (spec.action === 'replace') document['revision'] = spec.revision.toString()
  return {
    type: 'document',
    userFeeIncrease: 0,
    ownerId: ctx.ownerId,
    contractId: spec.contractId,
    identityContractNonce: ctx.nonce.toString(),
    document,
    signer: ctx.signer,
  }
}

/** The proposal's `derived`: the document id, and for a replace the revision it writes (stored + 1), as `dti` derives them. */
export function derivedFor(spec: WriteSpec, built: BuiltTransition): Record<string, string> {
  return spec.action === 'replace' ? { documentId: built.documentId, newRevision: (spec.revision + 1n).toString() } : { documentId: built.documentId }
}

export async function signedTransition(unsignedHex: string, signatureHex: string): Promise<StateTransition> {
  const m = await sdkModule()
  const st = m.StateTransition.fromBytes(unhex(unsignedHex))
  if (hex(st.toBytes()) !== unsignedHex) throw new Error('the transition bytes do not re-encode to themselves')
  const sig = unhex(signatureHex)
  if (sig.length !== 96) throw new Error('a BLS signature is 96 bytes')
  st.signature = sig
  return st
}
