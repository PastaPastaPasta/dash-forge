/**
 * Write paths — the browser signing surface (M3 writes implemented).
 *
 * Every write builds a document whose on-chain encoding matches forge-core byte-for-byte
 * (identifier fields as raw 32-byte values, `refNameHash = sha256(refName)`, event `kind`
 * integers, JSON-in-string list fields), signs it with the acting identity's key via the
 * {@link createDocumentIdempotent} WriteEngine, and returns a cost preview for the confirm UI.
 *
 * Implemented: createIssue, createComment, addEvent (+ close/reopen/label), starRepo/unstar,
 * follow/unfollow, createRelease (MAINTAIN), grant/suspend collaborator (token mint/freeze,
 * CRITICAL key), createRepo (contract instantiation), pushRefUpdate (minimal). All are
 * idempotent — a duplicate-unique collision (re-star, re-follow) resolves as success.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes } from '@noble/hashes/utils.js'

import { NETWORKS } from '../constants'
import { isLegalRefName } from '../rules'
import { decodeIdentifier } from '../auth/base58'
import {
  createDocumentIdempotent,
  createRepoContract,
  deleteDocumentIdempotent,
  grantRole,
  previewCredits,
  previewDocumentCreate,
  queryDocumentsWithProof,
  suspendRole,
  revokeRole,
  COST_ESTIMATE_CREDITS,
  SECURITY_LEVEL,
  type CostPreview,
  type WriteAuth,
  type WriteResult,
} from '../sdk'
import { DOC, REGISTRY_DOC, type RepoRef } from './contract'

/** Raised only by paths that remain out of scope for M3 (browser push internals). */
export class WriteNotImplementedError extends Error {
  constructor(op: string) {
    super(`${op}: not implemented in M3 (advanced browser push — issues/collab/stars are the priorities)`)
    this.name = 'WriteNotImplementedError'
  }
}

// ---------------------------------------------------------------------------
// event kind name → integer (parity with forge-core `event_kind_to_u64`)
// ---------------------------------------------------------------------------

export type EventKindName =
  | 'close'
  | 'reopen'
  | 'merge'
  | 'labelAdd'
  | 'labelRemove'
  | 'assign'
  | 'unassign'
  | 'retarget'
  | 'draft'
  | 'ready'

const EVENT_KIND_INT: Readonly<Record<EventKindName, number>> = {
  close: 1,
  reopen: 2,
  merge: 3,
  labelAdd: 4,
  labelRemove: 5,
  assign: 6,
  unassign: 7,
  retarget: 8,
  draft: 9,
  ready: 10,
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** A unique-index collision — for star/follow/issue-number this means "already there". */
function isDuplicateUniqueError(e: unknown): boolean {
  const m = errorMessage(e).toLowerCase()
  return m.includes('duplicate') || m.includes('unique index') || m.includes('already exists')
}

function registryId(auth: WriteAuth): string {
  const id = NETWORKS[auth.network].registryContractId
  if (id === null) throw new Error(`no registry contract configured for ${auth.network}`)
  return id
}

async function nextIssueNumber(sdk: EvoSDK, repo: RepoRef): Promise<number> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.issue,
    orderBy: [['number', 'desc']],
    limit: 1,
  })
  // Content integer fields come back as bigint (only system fields are normalized to number).
  const top = documents[0]?.['number']
  const max = typeof top === 'bigint' ? Number(top) : typeof top === 'number' ? top : 0
  return max + 1
}

// ---------------------------------------------------------------------------
// Issues / comments / events
// ---------------------------------------------------------------------------

/** A created issue: the write result plus the allocated issue number. */
export interface CreateIssueResult extends WriteResult {
  readonly number: number
}

/**
 * Create an `issue` (ungated create; author-owned). The number is optimistically `max+1`,
 * retried on a unique-index collision (a concurrent create took it). Returns the write result
 * and final number.
 */
export async function createIssue(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { title: string; body: string },
): Promise<CreateIssueResult> {
  let number = await nextIssueNumber(sdk, repo)
  for (let attempt = 0; attempt < 5; attempt++) {
    const data: Record<string, unknown> = { number, title: input.title }
    if (input.body.length > 0) data['body'] = input.body
    try {
      const result = await createDocumentIdempotent(sdk, auth, {
        contractId: repo.contractId,
        documentType: DOC.issue,
        data,
      })
      return { ...result, number }
    } catch (e) {
      if (isDuplicateUniqueError(e)) {
        number += 1
        continue
      }
      throw e
    }
  }
  throw new Error('exhausted issue-number allocation attempts')
}

/** Create a `comment` on an issue/PR (ungated; author-owned). */
export async function createComment(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { targetId: string; body: string; replyTo?: string },
): Promise<WriteResult> {
  const data: Record<string, unknown> = {
    targetId: decodeIdentifier(input.targetId),
    body: input.body,
  }
  if (input.replyTo) data['replyTo'] = decodeIdentifier(input.replyTo)
  return createDocumentIdempotent(sdk, auth, {
    contractId: repo.contractId,
    documentType: DOC.comment,
    data,
  })
}

/**
 * Append an `event` (close/reopen/label/assign/…) to the append-only state log. The event is
 * authoritative only if the fold deems the actor authorized as-of its `$createdAt`; a
 * non-holder's event lands but is inert. `oidHex` (a git object id) is optional.
 */
export async function addEvent(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { targetId: string; kind: EventKindName; value?: string; oidHex?: string },
): Promise<WriteResult> {
  const data: Record<string, unknown> = {
    targetId: decodeIdentifier(input.targetId),
    kind: EVENT_KIND_INT[input.kind],
  }
  if (input.value !== undefined && input.value.length > 0) data['value'] = input.value
  if (input.oidHex !== undefined && input.oidHex.length > 0) data['oid'] = hexToBytes(input.oidHex)
  return createDocumentIdempotent(sdk, auth, {
    contractId: repo.contractId,
    documentType: DOC.event,
    data,
  })
}

/** Convenience: close an issue/PR. */
export function closeTarget(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  targetId: string,
): Promise<WriteResult> {
  return addEvent(sdk, auth, repo, { targetId, kind: 'close' })
}

/** Convenience: reopen an issue/PR. */
export function reopenTarget(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  targetId: string,
): Promise<WriteResult> {
  return addEvent(sdk, auth, repo, { targetId, kind: 'reopen' })
}

/** Convenience: add or remove a label (MAINTAIN-authoritative via the fold). */
export function labelTarget(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  targetId: string,
  label: string,
  remove = false,
): Promise<WriteResult> {
  return addEvent(sdk, auth, repo, {
    targetId,
    kind: remove ? 'labelRemove' : 'labelAdd',
    value: label,
  })
}

// ---------------------------------------------------------------------------
// Releases (MAINTAIN-gated) + labels
// ---------------------------------------------------------------------------

/** A release asset (hash-verified download; stored JSON-in-string, D1). */
export interface ReleaseAsset {
  readonly name: string
  readonly sha256: string
  readonly size: number
  readonly uri: string
}

/** Create a `release` (MAINTAIN-gated). Assets are JSON-encoded (v12: no native arrays). */
export async function createRelease(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: {
    tagName: string
    name?: string
    notes?: string
    yanked?: boolean
    assets?: readonly ReleaseAsset[]
  },
): Promise<WriteResult> {
  const data: Record<string, unknown> = { tagName: input.tagName, yanked: input.yanked ?? false }
  if (input.name && input.name.length > 0) data['name'] = input.name
  if (input.notes && input.notes.length > 0) data['notes'] = input.notes
  if (input.assets && input.assets.length > 0) data['assets'] = JSON.stringify(input.assets)
  return createDocumentIdempotent(sdk, auth, {
    contractId: repo.contractId,
    documentType: DOC.release,
    data,
  })
}

/** Create (or supersede) a `label` definition (MAINTAIN-gated; newest doc per name wins). */
export async function createLabel(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { name: string; color?: string; description?: string; retired?: boolean },
): Promise<WriteResult> {
  const data: Record<string, unknown> = { name: input.name, retired: input.retired ?? false }
  if (input.color && input.color.length > 0) data['color'] = input.color
  if (input.description && input.description.length > 0) data['description'] = input.description
  return createDocumentIdempotent(sdk, auth, {
    contractId: repo.contractId,
    documentType: DOC.label,
    data,
  })
}

// ---------------------------------------------------------------------------
// Social (registry) — stars + follows
// ---------------------------------------------------------------------------

/** Star a repo listing (`star` create in the registry). Idempotent: a re-star is a success. */
export async function starRepo(
  sdk: EvoSDK,
  auth: WriteAuth,
  listingId: string,
): Promise<WriteResult> {
  const contractId = registryId(auth)
  try {
    return await createDocumentIdempotent(sdk, auth, {
      contractId,
      documentType: REGISTRY_DOC.star,
      data: { listingId: decodeIdentifier(listingId) },
    })
  } catch (e) {
    if (isDuplicateUniqueError(e)) {
      const existing = await findOwnRegistryDoc(sdk, auth, REGISTRY_DOC.star, 'listingId', listingId)
      return {
        documentId: existing ?? '',
        confirmed: true,
        cost: previewDocumentCreate(REGISTRY_DOC.star),
      }
    }
    throw e
  }
}

/** Unstar a repo (delete the caller's own `star` for `listingId`). No-op if not starred. */
export async function unstarRepo(
  sdk: EvoSDK,
  auth: WriteAuth,
  listingId: string,
): Promise<{ deleted: boolean }> {
  const contractId = registryId(auth)
  const existing = await findOwnRegistryDoc(sdk, auth, REGISTRY_DOC.star, 'listingId', listingId)
  if (!existing) return { deleted: true }
  return deleteDocumentIdempotent(sdk, auth, {
    contractId,
    documentType: REGISTRY_DOC.star,
    documentId: existing,
  })
}

/** Follow an identity (`follow` create in the registry). Idempotent. */
export async function followIdentity(
  sdk: EvoSDK,
  auth: WriteAuth,
  identityId: string,
): Promise<WriteResult> {
  const contractId = registryId(auth)
  try {
    return await createDocumentIdempotent(sdk, auth, {
      contractId,
      documentType: REGISTRY_DOC.follow,
      data: { identityId: decodeIdentifier(identityId) },
    })
  } catch (e) {
    if (isDuplicateUniqueError(e)) {
      const existing = await findOwnRegistryDoc(
        sdk,
        auth,
        REGISTRY_DOC.follow,
        'identityId',
        identityId,
      )
      return {
        documentId: existing ?? '',
        confirmed: true,
        cost: previewDocumentCreate(REGISTRY_DOC.follow),
      }
    }
    throw e
  }
}

/** Unfollow an identity (delete the caller's own `follow`). No-op if not following. */
export async function unfollowIdentity(
  sdk: EvoSDK,
  auth: WriteAuth,
  identityId: string,
): Promise<{ deleted: boolean }> {
  const contractId = registryId(auth)
  const existing = await findOwnRegistryDoc(sdk, auth, REGISTRY_DOC.follow, 'identityId', identityId)
  if (!existing) return { deleted: true }
  return deleteDocumentIdempotent(sdk, auth, {
    contractId,
    documentType: REGISTRY_DOC.follow,
    documentId: existing,
  })
}

/**
 * Resolve the caller's own registry doc (star/follow) whose `field` equals `targetId`, via the
 * `$ownerId` index (filtered client-side by field — the single-field owner query matches the
 * deployed registry index, mirroring forge-core `find_own`).
 */
async function findOwnRegistryDoc(
  sdk: EvoSDK,
  auth: WriteAuth,
  documentType: string,
  field: string,
  targetId: string,
): Promise<string | null> {
  const contractId = registryId(auth)
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: contractId,
    documentTypeName: documentType,
    where: [['$ownerId', '==', auth.identityId]],
    orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
    limit: 100,
  })
  for (const doc of documents) {
    const v = doc[field]
    // Identifier fields come back base58 from the SDK's toObject(); compare directly.
    if (typeof v === 'string' && v === targetId) {
      const id = doc['$id']
      if (typeof id === 'string') return id
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Collaborators (token admin — CRITICAL key)
// ---------------------------------------------------------------------------

/** Grant a collaborator WRITE (`maintain=false`) or MAINTAIN (`maintain=true`) — token mint. */
export async function grantCollaborator(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  memberId: string,
  maintain: boolean,
): Promise<{ minted: boolean; cost: CostPreview }> {
  const result = await grantRole(sdk, auth, repo.contractId, memberId, maintain ? 'maintain' : 'write')
  return { ...result, cost: previewCredits(COST_ESTIMATE_CREDITS.tokenAdmin) }
}

/** Suspend (freeze) a collaborator's role — token freeze. */
export async function suspendCollaborator(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  memberId: string,
  maintain: boolean,
): Promise<{ frozen: boolean; cost: CostPreview }> {
  const result = await suspendRole(sdk, auth, repo.contractId, memberId, maintain ? 'maintain' : 'write')
  return { ...result, cost: previewCredits(COST_ESTIMATE_CREDITS.tokenAdmin) }
}

/** Revoke a collaborator's role — token freeze + destroy. */
export async function revokeCollaborator(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  memberId: string,
  maintain: boolean,
): Promise<{ revoked: boolean; cost: CostPreview }> {
  const result = await revokeRole(sdk, auth, repo.contractId, memberId, maintain ? 'maintain' : 'write')
  return { ...result, cost: previewCredits(COST_ESTIMATE_CREDITS.tokenAdmin) }
}

// ---------------------------------------------------------------------------
// Repo lifecycle
// ---------------------------------------------------------------------------

/** Options for {@link createRepo}. */
export interface CreateRepoOptions {
  readonly defaultBranch?: string
  readonly backendMode?: number
  readonly description?: string
  readonly templateVersion?: number
}

/** A created repo: its contract id, the registry listing id, and the cost preview. */
export interface CreateRepoResult {
  readonly contractId: string
  readonly listingId: string
  readonly cost: CostPreview
}

/** Validate + normalize a repo name (`^[a-z0-9][a-z0-9._-]{0,62}$` after lowercasing). */
export function normalizeRepoName(name: string): string {
  const normalized = name.toLowerCase()
  const bytes = new TextEncoder().encode(normalized)
  const first = bytes[0]
  const valid =
    bytes.length >= 1 &&
    bytes.length <= 63 &&
    first !== undefined &&
    isAlnum(first) &&
    bytes.slice(1).every((b) => isAlnum(b) || b === 0x2e || b === 0x2d || b === 0x5f)
  if (!valid) {
    throw new Error(`invalid repo name '${name}': must match ^[a-z0-9][a-z0-9._-]{0,62}$`)
  }
  return normalized
}

function isAlnum(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x7a)
}

/**
 * Create a repository: instantiate its per-repo token contract (the ~1.18 DASH DataContractCreate,
 * CRITICAL key) then write its initial `config` (MAINTAIN — owner holds it via baseSupply) and the
 * registry `repoListing` (ungated). Idempotent at the contract level via the caller's deterministic
 * identity nonce; the follow-on config/listing writes are individually idempotent.
 */
export async function createRepo(
  sdk: EvoSDK,
  auth: WriteAuth,
  name: string,
  opts: CreateRepoOptions = {},
): Promise<CreateRepoResult> {
  const normalized = normalizeRepoName(name)
  const contract = await createRepoContract(sdk, auth)
  const contractId = contract.contractId

  // config (MAINTAIN-gated create; auto tokenPayment via the gate table).
  await createDocumentIdempotent(sdk, auth, {
    contractId,
    documentType: DOC.config,
    data: {
      defaultBranch: opts.defaultBranch ?? 'main',
      protectedPatterns: '[]',
      backend: { mode: opts.backendMode ?? 0, uris: '[]' },
      archived: false,
    },
    requiredLevel: SECURITY_LEVEL.HIGH,
  })

  // registry repoListing (ungated).
  const listing = await createDocumentIdempotent(sdk, auth, {
    contractId: registryId(auth),
    documentType: REGISTRY_DOC.repoListing,
    data: {
      name,
      normalizedName: normalized,
      repoContractId: decodeIdentifier(contractId),
      templateVersion: opts.templateVersion ?? 1,
      description: opts.description ?? '',
      topics: '[]',
    },
  })

  return {
    contractId,
    listingId: listing.documentId,
    cost: previewCredits(COST_ESTIMATE_CREDITS.repoCreate),
  }
}

// ---------------------------------------------------------------------------
// Ref updates (minimal browser push)
// ---------------------------------------------------------------------------

/**
 * Post a `refUpdate` (WRITE-gated) — the minimal browser push. `newOidHex`/`prevOidHex` are git
 * object ids (hex); an all-zero `newOid` is a delete. `refNameHash = sha256(refName)` matches
 * forge-core. Protected-ref routing (to `protectedRefUpdate`, MAINTAIN) requires the repo's
 * config patterns; pass `protected` when known. Full browser push (pack chunking) is out of M3.
 */
export async function pushRefUpdate(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: {
    refName: string
    newOidHex: string
    prevOidHex?: string
    force?: boolean
    protected?: boolean
  },
): Promise<WriteResult> {
  if (!isLegalRefName(input.refName)) {
    throw new Error(`illegal ref name ${JSON.stringify(input.refName)}`)
  }
  const refNameHash = sha256(new TextEncoder().encode(input.refName))
  const data: Record<string, unknown> = {
    refNameHash,
    refName: input.refName,
    newOid: hexToBytes(input.newOidHex),
    force: input.force ?? false,
  }
  if (input.prevOidHex && input.prevOidHex.length > 0) {
    data['prevOid'] = hexToBytes(input.prevOidHex)
  }
  const documentType = input.protected ? DOC.protectedRefUpdate : DOC.refUpdate
  return createDocumentIdempotent(sdk, auth, {
    contractId: repo.contractId,
    documentType,
    data,
  })
}
