/**
 * Write paths — the browser signing surface, for forge-v2 repos and (where still cheap) v1.
 *
 * Every write builds a document whose on-chain encoding matches forge-core byte for byte
 * (identifier fields as raw 32-byte values, `refNameHash = sha256(refName)`, event `kind`
 * integers), signs it through the {@link createDocumentIdempotent} WriteEngine, and returns
 * the estimate shown before signing plus the balance change it caused.
 *
 * forge-v2 (`docs/contracts/forge-v2.md`): a repo is three documents in forge-core (`repo`,
 * the owner's `maintainer`, the first `config`), created resumably; members are `maintainer` /
 * `writer` documents the owner creates and deletes; issues, comments, reviews, `event`
 * (members) and `authorEvent` (the author's close/reopen) live in forge-collab, and consensus
 * enforces every gate. `star` and `follow` are `indexOnly`: a delete carries the document's
 * values (the SDK's index-only delete). Issue numbers follow the `allocateNumber` rule (§6).
 *
 * v1 (testnet): issue, comment, event, review, release, star, follow and the collaborator
 * token admin keep working for existing repos. Creating a v1 repo from the browser is gone:
 * new repos are forge-v2 (a v1 repo was a ~1.18 DASH contract).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { hexToBytes } from '@noble/hashes/utils.js'

import { requireRegistryContractId, type Network } from '../constants'
import type { ForgeIds } from '../deployments'
import { decodeIdentifier } from '../auth/base58'
import { idbDelete, idbEntries, idbPut } from '../idb'
import { allocateNumber, numberCeiling, normalizeRepoName as normalizeV2RepoName, type Role } from '../rules/v2'
import {
  ConsensusRefusal,
  DUPLICATE_UNIQUE_CODE,
  GATE_REFUSED_CODE,
  createGateFor,
  countDocuments,
  createDocumentIdempotent,
  deleteDocumentIdempotent,
  grantRole,
  previewCredits,
  queryAllDocuments,
  queryDocumentsWithProof,
  revokeRole,
  suspendRole,
  type DeleteResult,
  type WriteAuth,
  type WriteResult,
} from '../sdk'
import { DOC, REGISTRY_DOC, V2_DOC, asIdentifierString, num, str, type RepoRef, type V1RepoRef, type V2RepoRef } from './contract'
import { invalidateMembers } from './members'
import { invalidateRepoFeed } from './issues'
import { repoSource } from './source'
import { invalidateAuthz } from './tokens'

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

/** Review verdicts (`review.verdict`). */
export const VERDICT_INT = { approve: 1, requestChanges: 2, comment: 3 } as const
export type VerdictInput = keyof typeof VERDICT_INT

/** An issue or PR a write refers to: its document id and number. */
export interface WriteTarget {
  readonly id: string
  readonly number: number
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isDuplicate(e: unknown): boolean {
  return e instanceof ConsensusRefusal && e.code === DUPLICATE_UNIQUE_CODE
}

/** The contract a write of `documentType` targets, for either data model. */
function contractFor(repo: RepoRef, documentType: string): string {
  return repo.kind === 'v1' ? repo.contractId : repoSource(repo).repoQuery(documentType).dataContractId
}

/** `data` plus, on forge-v2, the `repoId` every repo-scoped type carries. */
function scoped(repo: RepoRef, data: Record<string, unknown>): Record<string, unknown> {
  return repo.kind === 'v1' ? data : { repoId: decodeIdentifier(repo.repoId), ...data }
}

/** Drop the caches a write to `repo` invalidates, so the next read shows it. */
function afterWrite(repo: RepoRef, network: Network): void {
  if (repo.kind === 'v2') {
    invalidateRepoFeed(repo)
    invalidateMembers(repo, network)
  }
}

/**
 * Create one repo-scoped document: the right contract, `repoId` on v2, the v1 token gate on
 * v1 (forge-v2 types carry none), then drop the caches the write invalidates.
 */
async function writeRepoDoc(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  documentType: string,
  data: Record<string, unknown>,
): Promise<WriteResult> {
  const result = await createDocumentIdempotent(sdk, auth, {
    contractId: contractFor(repo, documentType),
    documentType,
    data: scoped(repo, data),
    gate: repo.kind === 'v1' ? createGateFor(documentType) ?? null : null,
  })
  afterWrite(repo, auth.network)
  return result
}

/** A write that found its unique slot already held by the signer: success, nothing spent. */
function alreadyThere(documentId: string | null): WriteResult {
  return { documentId: documentId ?? '', confirmed: true, cost: previewCredits(0), actualCredits: 0 }
}

/** A delete of something already gone. */
const ALREADY_GONE: DeleteResult = { deleted: true, actualCredits: 0 }

/** Run a create; a duplicate-unique refusal (the signer's own earlier write) is success. */
async function createOrExisting(create: () => Promise<WriteResult>, findExisting: () => Promise<string | null> = async () => null): Promise<WriteResult> {
  try {
    return await create()
  } catch (e) {
    if (!isDuplicate(e)) throw e
    return alreadyThere(await findExisting())
  }
}

/** The `$id` of the first row, or null. */
function firstId(documents: readonly Record<string, unknown>[]): string | null {
  const id = documents[0]?.['$id']
  return typeof id === 'string' ? id : null
}

// ---------------------------------------------------------------------------
// Issue numbering (forge-v2.md §6 `allocate_number`; v1 keeps max + 1)
// ---------------------------------------------------------------------------

/** The `number` field of a result row, or null. */
function numberOf(doc: Record<string, unknown>): number | null {
  const n = num(doc, 'number')
  return n > 0 ? n : null
}

/**
 * The number the allocation rule gives the next issue (or PR) of a forge-v2 repo:
 * `n` = the provable count, `base` = the largest taken number at or below the ceiling, then
 * — only when `base` sits at the ceiling — the contiguous run of taken numbers above it,
 * paged to its end. Null when nothing is left to allocate.
 */
export async function nextNumberV2(sdk: EvoSDK, repo: V2RepoRef, type: 'issue' | 'patch'): Promise<number | null> {
  const source = repoSource(repo)
  const count = await countDocuments(sdk, source.repoQuery(DOC[type]))
  const ceiling = numberCeiling(count)
  const { documents } = await queryDocumentsWithProof(
    sdk,
    source.repoQuery(DOC[type], {
      where: [['number', '<=', ceiling]],
      orderBy: [['number', 'desc']],
      limit: 1,
    }),
  )
  const base = documents[0] ? numberOf(documents[0]) ?? 0 : 0
  const taken: number[] = base > 0 ? [base] : []
  if (base === ceiling) {
    // Squatters may sit right above the ceiling: walk the run to its first gap.
    let expect = base + 1
    let startAfter: string | undefined
    for (;;) {
      const page = await queryDocumentsWithProof(
        sdk,
        source.repoQuery(DOC[type], {
          where: [['number', '>', base]],
          orderBy: [['number', 'asc']],
          limit: 100,
          ...(startAfter ? { startAfter } : {}),
        }),
      )
      let gap = false
      for (const d of page.documents) {
        const n = numberOf(d)
        if (n !== expect) {
          gap = true
          break
        }
        taken.push(n)
        expect += 1
      }
      const last = page.documents[page.documents.length - 1]
      if (gap || page.documents.length < 100 || last === undefined) break
      startAfter = str(last, '$id')
    }
  }
  return allocateNumber(count, taken.sort((a, b) => b - a))
}

/** v1: the newest number + 1 (a v1 repo contract has no numbering rule beyond uniqueness). */
async function nextNumberV1(sdk: EvoSDK, repo: V1RepoRef): Promise<number> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.issue,
    orderBy: [['number', 'desc']],
    limit: 1,
  })
  return (documents[0] ? numberOf(documents[0]) ?? 0 : 0) + 1
}

// ---------------------------------------------------------------------------
// Issues / comments / events / reviews
// ---------------------------------------------------------------------------

/** A created issue: the write result plus the allocated issue number. */
export interface CreateIssueResult extends WriteResult {
  readonly number: number
}

/**
 * Create an `issue` (ungated; anyone). The number comes from the repo's numbering rule; when
 * consensus refuses it as taken (someone claimed it between the read and the write), the
 * allocation runs again — the squatted number is now `base` — and `onRetry` is told, so the
 * UI can say "Someone claimed #42 a moment ago; retrying as #43" (`ux-dx-spec.md` §1d).
 */
export async function createIssue(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { title: string; body: string },
  onRetry?: (taken: number, next: number) => void,
): Promise<CreateIssueResult> {
  let number = repo.kind === 'v2' ? await nextNumberV2(sdk, repo, 'issue') : await nextNumberV1(sdk, repo)
  for (let attempt = 0; attempt < 4; attempt++) {
    if (number === null) throw new Error('this repo has no issue numbers left to allocate')
    const data: Record<string, unknown> = { number, title: input.title }
    if (input.body.length > 0) data['body'] = input.body
    try {
      return { ...(await writeRepoDoc(sdk, auth, repo, DOC.issue, data)), number }
    } catch (e) {
      if (!isDuplicate(e)) throw e
      const taken: number = number
      number = repo.kind === 'v2' ? await nextNumberV2(sdk, repo, 'issue') : taken + 1
      if (number !== null && number <= taken) number = taken + 1
      if (number !== null) onRetry?.(taken, number)
    }
  }
  throw new Error('could not claim an issue number after several attempts; try again')
}

/** Create a `comment` on an issue or PR (ungated; author-owned). */
export async function createComment(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { targetId: string; body: string; replyTo?: string },
): Promise<WriteResult> {
  const data: Record<string, unknown> = { targetId: decodeIdentifier(input.targetId), body: input.body }
  if (input.replyTo) data['replyTo'] = decodeIdentifier(input.replyTo)
  return writeRepoDoc(sdk, auth, repo, DOC.comment, data)
}

/** The document data of a state event on `target`. */
function eventData(
  repo: RepoRef,
  target: WriteTarget,
  kind: EventKindName,
  extra: { value?: string; oidHex?: string } = {},
): Record<string, unknown> {
  const data: Record<string, unknown> = { targetId: decodeIdentifier(target.id), kind: EVENT_KIND_INT[kind] }
  if (repo.kind === 'v2') data['targetNumber'] = target.number
  if (extra.value !== undefined && extra.value.length > 0) data['value'] = extra.value
  if (extra.oidHex !== undefined && extra.oidHex.length > 0) data['oid'] = hexToBytes(extra.oidHex)
  return data
}

/**
 * Append a member `event` (close / reopen / label / assign / merge mark, …). On forge-v2
 * consensus admits it only from a current maintainer or writer (40120 otherwise); on v1 it
 * lands for anyone and the fold decides whether it counts.
 */
export async function addEvent(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { target: WriteTarget; kind: EventKindName; value?: string; oidHex?: string },
): Promise<WriteResult> {
  return writeRepoDoc(sdk, auth, repo, DOC.event, eventData(repo, input.target, input.kind, input))
}

/**
 * The issue or PR author's own close / reopen. forge-v2 has a type for it (`authorEvent`,
 * gated to the target's author, `forge-v2.md` §3); v1 folds the author's plain `event`.
 */
export async function addAuthorEvent(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { target: WriteTarget; kind: 'close' | 'reopen' },
): Promise<WriteResult> {
  if (repo.kind === 'v1') return addEvent(sdk, auth, repo, input)
  return writeRepoDoc(sdk, auth, repo, V2_DOC.authorEvent, eventData(repo, input.target, input.kind))
}

/** Which state-event type a close/reopen by the viewer should be. */
export function stateEventRoute(params: {
  readonly viewer: string
  readonly author: string
  readonly isMember: boolean
}): 'event' | 'authorEvent' | null {
  // A member's event is cheaper and needs no authorship; the author path needs no membership.
  if (params.isMember) return 'event'
  return params.viewer === params.author ? 'authorEvent' : null
}

/** Close or reopen an issue/PR by whichever route the viewer holds. */
export async function setTargetState(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { target: WriteTarget; kind: 'close' | 'reopen'; author: string; isMember: boolean },
): Promise<WriteResult> {
  const route = stateEventRoute({ viewer: auth.identityId, author: input.author, isMember: input.isMember })
  if (route === null) throw new Error('only the author or a maintainer or writer can do that')
  if (route === 'authorEvent') return addAuthorEvent(sdk, auth, repo, input)
  try {
    return await addEvent(sdk, auth, repo, input)
  } catch (e) {
    // The membership read was stale (revoked meanwhile): the author path still holds.
    const gateRefused = e instanceof ConsensusRefusal && e.code === GATE_REFUSED_CODE
    if (gateRefused && auth.identityId === input.author) return addAuthorEvent(sdk, auth, repo, input)
    throw e
  }
}

/** Submit a PR review: a verdict on `commitOid` (the head it was made against). */
export async function createReview(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { patchId: string; verdict: VerdictInput; commitOid: string; body?: string },
): Promise<WriteResult> {
  const data: Record<string, unknown> = {
    patchId: decodeIdentifier(input.patchId),
    verdict: VERDICT_INT[input.verdict],
    commitOid: hexToBytes(input.commitOid),
  }
  if (input.body && input.body.length > 0) data['body'] = input.body
  return writeRepoDoc(sdk, auth, repo, DOC.review, data)
}

// ---------------------------------------------------------------------------
// Releases (maintainer-only on v2; MAINTAIN-gated on v1)
// ---------------------------------------------------------------------------

/** A release asset (hash-verified download; stored as a JSON string). */
export interface ReleaseAsset {
  readonly name: string
  readonly sha256: string
  readonly size: number
  readonly uri: string
}

/** Create a `release`: newest per tag wins. Maintainers only (consensus on v2). */
export async function createRelease(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: { tagName: string; name?: string; notes?: string; yanked?: boolean; assets?: readonly ReleaseAsset[] },
): Promise<WriteResult> {
  const data: Record<string, unknown> = { tagName: input.tagName, yanked: input.yanked ?? false }
  if (input.name && input.name.length > 0) data['name'] = input.name
  if (input.notes && input.notes.length > 0) data['notes'] = input.notes
  if (input.assets && input.assets.length > 0) data['assets'] = JSON.stringify(input.assets)
  return writeRepoDoc(sdk, auth, repo, DOC.release, data)
}

// ---------------------------------------------------------------------------
// forge-v2 social: star / follow (indexOnly)
// ---------------------------------------------------------------------------

interface RawDocumentsFacade {
  query(q: unknown): Promise<Map<string, unknown>>
}

/**
 * The viewer's own `star` / `follow` document for `targetId` as the wasm `Document` the query
 * returned — an index-only delete needs its values, not just an id. Null when there is none.
 * The `byOwner` index ends in the target, so `($ownerId, target)` selects at most one.
 */
async function findOwnIndexOnly(
  sdk: EvoSDK,
  forge: ForgeIds,
  type: 'star' | 'follow',
  ownerId: string,
  targetId: string,
): Promise<unknown | null> {
  const field = type === 'star' ? 'repoId' : 'identityId'
  const rows = await (sdk as unknown as { documents: RawDocumentsFacade }).documents.query({
    dataContractId: forge.collab,
    documentTypeName: type,
    where: [
      ['$ownerId', '==', ownerId],
      [field, '==', targetId],
    ],
    orderBy: [['$ownerId', 'asc']],
    limit: 1,
  })
  for (const doc of rows.values()) if (doc) return doc
  return null
}

/** Create the signer's `star` / `follow` (indexOnly). Idempotent: a duplicate is success. */
function createIndexOnly(sdk: EvoSDK, auth: WriteAuth, forge: ForgeIds, type: 'star' | 'follow', targetId: string): Promise<WriteResult> {
  const field = type === 'star' ? 'repoId' : 'identityId'
  return createOrExisting(() =>
    createDocumentIdempotent(sdk, auth, {
      contractId: forge.collab,
      documentType: type,
      data: { [field]: decodeIdentifier(targetId) },
      probe: async () => (await findOwnIndexOnly(sdk, forge, type, auth.identityId, targetId)) !== null,
    }),
  )
}

/** Delete the signer's `star` / `follow`: an index-only delete carrying its values. */
async function deleteIndexOnly(sdk: EvoSDK, auth: WriteAuth, forge: ForgeIds, type: 'star' | 'follow', targetId: string): Promise<DeleteResult> {
  const own = await findOwnIndexOnly(sdk, forge, type, auth.identityId, targetId)
  if (own === null) return ALREADY_GONE
  return deleteDocumentIdempotent(sdk, auth, {
    contractId: forge.collab,
    documentType: type,
    documentId: targetId,
    document: own,
    probeGone: async () => (await findOwnIndexOnly(sdk, forge, type, auth.identityId, targetId)) === null,
  })
}

/** An on/off relation the viewer holds (a star, a follow), in the shape `useRelationToggle` drives. */
export interface Relation {
  read(): Promise<boolean>
  add(): Promise<boolean>
  remove(): Promise<boolean>
}

/**
 * The viewer's star on a repo: forge-collab `star` on v2, the registry `star` on the v1
 * listing (`listingId`) otherwise.
 */
export function starRelation(sdk: EvoSDK, auth: WriteAuth | null, viewer: string, repo: RepoRef, listingId: string | null, network: Network): Relation {
  if (repo.kind === 'v2') {
    return {
      read: async () => (await findOwnIndexOnly(sdk, repo.forge, 'star', viewer, repo.repoId)) !== null,
      add: async () => (await createIndexOnly(sdk, need(auth), repo.forge, 'star', repo.repoId)).confirmed,
      remove: async () => (await deleteIndexOnly(sdk, need(auth), repo.forge, 'star', repo.repoId)).deleted,
    }
  }
  const listing = listingId ?? ''
  return {
    read: async () => (await findOwnRegistryDoc(sdk, network, viewer, REGISTRY_DOC.star, 'listingId', listing)) !== null,
    add: async () => (await createRegistryRelation(sdk, need(auth), REGISTRY_DOC.star, 'listingId', listing)).confirmed,
    remove: async () => (await deleteRegistryRelation(sdk, need(auth), REGISTRY_DOC.star, 'listingId', listing)).deleted,
  }
}

/** The viewer's follow of `target`: forge-collab `follow` where forge-v2 runs, else the registry. */
export function followRelation(sdk: EvoSDK, auth: WriteAuth | null, viewer: string, forge: ForgeIds | null, target: string, network: Network): Relation {
  if (forge !== null) {
    return {
      read: async () => (await findOwnIndexOnly(sdk, forge, 'follow', viewer, target)) !== null,
      add: async () => (await createIndexOnly(sdk, need(auth), forge, 'follow', target)).confirmed,
      remove: async () => (await deleteIndexOnly(sdk, need(auth), forge, 'follow', target)).deleted,
    }
  }
  return {
    read: async () => (await findOwnRegistryDoc(sdk, network, viewer, REGISTRY_DOC.follow, 'identityId', target)) !== null,
    add: async () => (await createRegistryRelation(sdk, need(auth), REGISTRY_DOC.follow, 'identityId', target)).confirmed,
    remove: async () => (await deleteRegistryRelation(sdk, need(auth), REGISTRY_DOC.follow, 'identityId', target)).deleted,
  }
}

function need(auth: WriteAuth | null): WriteAuth {
  if (auth === null) throw new Error('sign in first')
  return auth
}

// ---------------------------------------------------------------------------
// v1 social (registry) — stars + follows on existing v1 networks
// ---------------------------------------------------------------------------

/**
 * Resolve `ownerId`'s own registry doc (star/follow) whose `field` equals `targetId`, via the
 * `$ownerId` index (filtered client-side by field — the single-field owner query matches the
 * deployed registry index, mirroring forge-core `find_own`). Complete: a user past 100 stars
 * could otherwise not remove an older one.
 */
async function findOwnRegistryDoc(
  sdk: EvoSDK,
  network: Network,
  ownerId: string,
  documentType: string,
  field: string,
  targetId: string,
): Promise<string | null> {
  const documents = await queryAllDocuments(sdk, {
    dataContractId: requireRegistryContractId(network),
    documentTypeName: documentType,
    where: [['$ownerId', '==', ownerId]],
    orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
  })
  for (const doc of documents) {
    if (asIdentifierString(doc[field]) === targetId) {
      const id = doc['$id']
      if (typeof id === 'string') return id
    }
  }
  return null
}

async function createRegistryRelation(
  sdk: EvoSDK,
  auth: WriteAuth,
  documentType: string,
  field: string,
  targetId: string,
): Promise<WriteResult> {
  return createOrExisting(
    () =>
      createDocumentIdempotent(sdk, auth, {
        contractId: requireRegistryContractId(auth.network),
        documentType,
        data: { [field]: decodeIdentifier(targetId) },
      }),
    () => findOwnRegistryDoc(sdk, auth.network, auth.identityId, documentType, field, targetId),
  )
}

async function deleteRegistryRelation(
  sdk: EvoSDK,
  auth: WriteAuth,
  documentType: string,
  field: string,
  targetId: string,
): Promise<DeleteResult> {
  const existing = await findOwnRegistryDoc(sdk, auth.network, auth.identityId, documentType, field, targetId)
  if (!existing) return ALREADY_GONE
  return deleteDocumentIdempotent(sdk, auth, {
    contractId: requireRegistryContractId(auth.network),
    documentType,
    documentId: existing,
  })
}

// ---------------------------------------------------------------------------
// forge-v2 membership (owner-only)
// ---------------------------------------------------------------------------

const ROLE_DOC: Readonly<Record<Role, string>> = { maintainer: V2_DOC.maintainer, writer: V2_DOC.writer }

/** The membership document `(repoId, memberId)` of `role`, or null. */
async function findMembership(sdk: EvoSDK, repo: V2RepoRef, role: Role, memberId: string): Promise<string | null> {
  const { documents } = await queryDocumentsWithProof(
    sdk,
    repoSource(repo).repoQuery(ROLE_DOC[role], { where: [['memberId', '==', memberId]], limit: 1 }),
  )
  return firstId(documents)
}

/**
 * Grant `memberId` a role on a forge-v2 repo: the owner creates a `maintainer` or `writer`
 * document (consensus refuses anyone else). Idempotent: an existing membership is success.
 */
export async function grantMember(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: V2RepoRef,
  memberId: string,
  role: Role,
): Promise<WriteResult> {
  if (auth.identityId !== repo.ownerId) throw new Error('only the repo owner can add members')
  const result = await createOrExisting(
    () =>
      createDocumentIdempotent(sdk, auth, {
        contractId: repo.forge.core,
        documentType: ROLE_DOC[role],
        data: { repoId: decodeIdentifier(repo.repoId), memberId: decodeIdentifier(memberId) },
      }),
    () => findMembership(sdk, repo, role, memberId),
  )
  invalidateMembers(repo, auth.network)
  return result
}

/** Revoke a role: the owner deletes the membership document. No-op when there is none. */
export async function revokeMember(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: V2RepoRef,
  memberId: string,
  role: Role,
): Promise<DeleteResult> {
  if (auth.identityId !== repo.ownerId) throw new Error('only the repo owner can remove members')
  const existing = await findMembership(sdk, repo, role, memberId)
  if (existing === null) return ALREADY_GONE
  const result = await deleteDocumentIdempotent(sdk, auth, {
    contractId: repo.forge.core,
    documentType: ROLE_DOC[role],
    documentId: existing,
  })
  invalidateMembers(repo, auth.network)
  return result
}

// ---------------------------------------------------------------------------
// v1 collaborators (token admin — CRITICAL key)
// ---------------------------------------------------------------------------

/**
 * v1 collaborator token admin: grant (mint), suspend (freeze) or revoke (freeze + destroy) a
 * WRITE (`maintain=false`) or MAINTAIN role.
 */
export async function adminCollaborator(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: V1RepoRef,
  op: 'grant' | 'suspend' | 'revoke',
  memberId: string,
  maintain: boolean,
): Promise<void> {
  const role = maintain ? 'maintain' : 'write'
  if (op === 'grant') await grantRole(sdk, auth, repo.contractId, memberId, role)
  else if (op === 'suspend') await suspendRole(sdk, auth, repo.contractId, memberId, role)
  else await revokeRole(sdk, auth, repo.contractId, memberId, role)
  invalidateAuthz(repo.contractId)
}

// ---------------------------------------------------------------------------
// forge-v2 repo creation (three documents, resumable)
// ---------------------------------------------------------------------------

/** Options for {@link createRepoV2}. */
export interface CreateRepoInput {
  readonly name: string
  readonly description?: string
  readonly defaultBranch?: string
}

/** The steps of a repo creation, in order. */
export type CreateRepoStep = 'repo' | 'maintainer' | 'config'

/** A repo creation's journal entry (IndexedDB), kept until all three documents exist. */
export interface RepoCreationJournal {
  readonly network: Network
  readonly ownerId: string
  readonly input: CreateRepoInput
  readonly repoId: string | null
  readonly done: readonly CreateRepoStep[]
  readonly startedAt: number
}

/** A created (or completed) repo. */
export interface CreateRepoResult {
  readonly repoId: string
  readonly name: string
  /** Credits the steps this run performed took (null when a balance read failed). */
  readonly actualCredits: number | null
}

function journalKey(network: Network, ownerId: string, name: string): string {
  return `create-repo:${network}:${ownerId}:${name}`
}

/** Unfinished repo creations of `ownerId` (a tab closed mid-way), oldest first. */
export async function pendingRepoCreations(network: Network, ownerId: string): Promise<RepoCreationJournal[]> {
  const rows = await idbEntries<RepoCreationJournal>('journal', `create-repo:${network}:${ownerId}:`)
  return rows.map(([, v]) => v).sort((a, b) => a.startedAt - b.startedAt)
}

/** Forget an unfinished creation (the user abandoned it). */
export function discardRepoCreation(network: Network, ownerId: string, name: string): Promise<void> {
  return idbDelete('journal', journalKey(network, ownerId, name))
}

/** A valid forge-v2 repo name for `input` (ASCII lowercased), or an error saying why not. */
export function normalizeRepoName(input: string): string {
  const name = normalizeV2RepoName(input.trim())
  if (name === null) {
    throw new Error(`invalid repo name '${input}': use a-z, 0-9, '.', '_' and '-' (max 63), starting with a letter or digit`)
  }
  return name
}

/**
 * Create a forge-v2 repository: its `repo` document, the owner's `maintainer` document (the
 * owner self-enrols, `forge-v2.md` §6, or nobody could push) and its first `config`. Each step
 * checks the chain first, so a rerun after an interruption completes what is missing instead
 * of failing on the unique `($ownerId, name)` index; the IndexedDB journal lets the UI offer
 * that rerun. `onStep` reports progress.
 */
export async function createRepoV2(
  sdk: EvoSDK,
  auth: WriteAuth,
  forge: ForgeIds,
  input: CreateRepoInput,
  onStep?: (step: CreateRepoStep, state: 'start' | 'done') => void,
): Promise<CreateRepoResult> {
  const name = normalizeRepoName(input.name)
  const ownerId = auth.identityId
  const key = journalKey(auth.network, ownerId, name)
  const journal: { -readonly [K in keyof RepoCreationJournal]: RepoCreationJournal[K] } = {
    network: auth.network,
    ownerId,
    input: { ...input, name },
    repoId: null,
    done: [],
    startedAt: Date.now(),
  }
  const save = (): Promise<void> => idbPut('journal', key, journal)
  await save()
  let spent: number | null = 0
  const add = (r: { actualCredits: number | null }): void => {
    spent = spent === null || r.actualCredits === null ? null : spent + r.actualCredits
  }
  const step = async (s: CreateRepoStep, run: () => Promise<void>): Promise<void> => {
    onStep?.(s, 'start')
    await run()
    journal.done = [...journal.done, s]
    await save()
    onStep?.(s, 'done')
  }

  // 1. repo (unique per owner + name)
  const existingRepo = async (): Promise<string | null> => {
    const { documents } = await queryDocumentsWithProof(sdk, {
      dataContractId: forge.core,
      documentTypeName: V2_DOC.repo,
      where: [
        ['$ownerId', '==', ownerId],
        ['name', '==', name],
      ],
      limit: 1,
    })
    return firstId(documents)
  }
  let repoId = await existingRepo()
  await step('repo', async () => {
    if (repoId !== null) return
    const data: Record<string, unknown> = { name, visibility: 'public' }
    if (input.description) data['description'] = input.description
    if (input.defaultBranch) data['defaultBranch'] = input.defaultBranch
    try {
      const r = await createDocumentIdempotent(sdk, auth, { contractId: forge.core, documentType: V2_DOC.repo, data })
      add(r)
      repoId = r.documentId
    } catch (e) {
      if (!isDuplicate(e)) throw e
      repoId = await existingRepo()
      if (repoId === null) throw e
    }
  })
  if (repoId === null) throw new Error('the repo document did not land; try again')
  journal.repoId = repoId
  await save()
  const R = decodeIdentifier(repoId)
  const repo: V2RepoRef = { kind: 'v2', forge, repoId, ownerId, name, visibility: 'public' }

  // 2. the owner's maintainer document (unique per repo + member)
  await step('maintainer', async () => {
    if ((await findMembership(sdk, repo, 'maintainer', ownerId)) !== null) return
    try {
      add(
        await createDocumentIdempotent(sdk, auth, {
          contractId: forge.core,
          documentType: V2_DOC.maintainer,
          data: { repoId: R, memberId: decodeIdentifier(ownerId) },
        }),
      )
    } catch (e) {
      if (!isDuplicate(e)) throw e
    }
  })

  // 3. the first config (append-only; one is enough)
  await step('config', async () => {
    const { documents } = await queryDocumentsWithProof(sdk, repoSource(repo).repoQuery(DOC.config, { limit: 1 }))
    if (documents.length > 0) return
    add(
      await createDocumentIdempotent(sdk, auth, {
        contractId: forge.core,
        documentType: DOC.config,
        data: { repoId: R, defaultBranch: input.defaultBranch ?? 'main', backend: { mode: 0 } },
      }),
    )
  })

  await idbDelete('journal', key)
  invalidateMembers(repo, auth.network)
  return { repoId, name, actualCredits: spent }
}
