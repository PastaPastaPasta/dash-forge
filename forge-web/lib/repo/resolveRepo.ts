/**
 * Repo resolution — `(owner, name)` → a `RepoRef`.
 *
 * A repo is the forge-core `repo` document with unique `($ownerId, name)` on the network's
 * forge-v2 deployment (`forge-v2.md` §6: "the `repo` document is the listing"), so no
 * authenticity check is needed. `?repo=<repoId>` pins one by id, skipping the name lookup.
 * The owner may be an identity id or a DPNS name (`alice` / `alice.dash`).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Decode } from '../auth/base58'
import { DEFAULT_NETWORK, NETWORKS, type Network } from '../constants'
import type { ForgeIds } from '../deployments'
import { normalizeRepoName, type Visibility } from '../rules/v2'
import { queryDocumentsWithProof, type PlainDocument, type WhereClause } from '../sdk'
import { DOC, asIdentifierString, stringArray, type RepoRef } from './contract'

interface DpnsFacadeLike {
  dpns: { resolveName(name: string): Promise<string | undefined> }
}

/** A forge-v2 `repo` document, flattened. */
export interface RepoDoc {
  readonly repoId: string
  readonly ownerId: string
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly visibility: Visibility
  readonly defaultBranch: string | null
  readonly topics: readonly string[]
  /** The repo this was forked from (`forkOf`), or null. */
  readonly forkOf: string | null
  readonly createdAt: number
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && 'toString' in v) {
    const s = String(v)
    return s === '[object Object]' ? '' : s
  }
  return ''
}

/** Flatten a forge-core `repo` document. */
export function toRepoDoc(doc: PlainDocument): RepoDoc {
  const forkOf = asIdentifierString(doc['forkOf'])
  return {
    repoId: asString(doc['$id']),
    ownerId: asString(doc['$ownerId']),
    name: asString(doc['name']),
    displayName: asString(doc['displayName']),
    description: asString(doc['description']),
    visibility: doc['visibility'] === 'private' ? 'private' : 'public',
    defaultBranch: typeof doc['defaultBranch'] === 'string' ? doc['defaultBranch'] : null,
    topics: stringArray(doc, 'topics') ?? [],
    forkOf: forkOf === '' ? null : forkOf,
    createdAt: typeof doc['$createdAt'] === 'number' ? doc['$createdAt'] : 0,
  }
}

/** The {@link RepoRef} a `repo` document addresses. */
export function repoRefOf(forge: ForgeIds, repo: RepoDoc): RepoRef {
  return {
    forge,
    repoId: repo.repoId,
    ownerId: repo.ownerId,
    name: repo.name,
    visibility: repo.visibility,
  }
}

/** Whether `s` is a base58 identity / document id (32 bytes). */
function isIdentifier(s: string): boolean {
  try {
    return base58Decode(s).length === 32
  } catch {
    return false
  }
}

const ownerCache = new Map<string, { at: number; promise: Promise<string | null> }>()
/** How long a DPNS miss is believed (a name registered meanwhile resolves after it). */
const OWNER_MISS_TTL_MS = 5 * 60_000

/**
 * The identity an owner segment names: an identity id as is, else a DPNS name resolved
 * through the SDK (`alice` and `alice.dash` both work). Null when the name does not resolve.
 * A hit is cached for the session, a miss for {@link OWNER_MISS_TTL_MS}, a failure not at all.
 */
export function resolveOwner(sdk: EvoSDK, owner: string): Promise<string | null> {
  if (isIdentifier(owner)) return Promise.resolve(owner)
  const name = owner.toLowerCase().replace(/^@/, '')
  const full = name.includes('.') ? name : `${name}.dash`
  const hit = ownerCache.get(full)
  if (hit !== undefined) return hit.promise
  const promise = (sdk as unknown as DpnsFacadeLike).dpns
    .resolveName(full)
    .then((id) => (id ? asIdentifierString(id) || null : null))
  const entry = { at: Date.now(), promise }
  ownerCache.set(full, entry)
  const evict = (): void => {
    if (ownerCache.get(full) === entry) ownerCache.delete(full)
  }
  promise.then((id) => {
    if (id === null) setTimeout(evict, OWNER_MISS_TTL_MS)
  }, evict)
  return promise
}

/** The one forge-v2 `repo` document `where` selects, or null. */
async function readRepoDoc(
  sdk: EvoSDK,
  forge: ForgeIds,
  where: readonly WhereClause[],
): Promise<RepoDoc | null> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: forge.core,
    documentTypeName: DOC.repo,
    where,
    limit: 1,
  })
  const doc = documents[0]
  return doc === undefined ? null : toRepoDoc(doc)
}

/**
 * The forge-v2 `repo` documents of `ids` (at most 100, one proved read), in no particular order;
 * an id with no document is left out.
 */
export async function readReposById(sdk: EvoSDK, forge: ForgeIds, ids: readonly string[]): Promise<RepoDoc[]> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  if (unique.length > 100) throw new Error('readReposById reads at most 100 repos')
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: forge.core,
    documentTypeName: DOC.repo,
    where: [['$id', 'in', unique]],
    limit: unique.length,
  })
  return documents.map(toRepoDoc)
}

/** The forge-v2 `repo` document `($ownerId, name)`, or null. */
function readRepoByName(sdk: EvoSDK, forge: ForgeIds, ownerId: string, name: string): Promise<RepoDoc | null> {
  return readRepoDoc(sdk, forge, [
    ['$ownerId', '==', ownerId],
    ['name', '==', name],
  ])
}

/** The forge-v2 `repo` document with id `repoId`, or null. */
export function readRepoById(sdk: EvoSDK, forge: ForgeIds, repoId: string): Promise<RepoDoc | null> {
  return readRepoDoc(sdk, forge, [['$id', '==', repoId]])
}

/** What resolved: the repo and its `repo` document. */
export interface ResolvedRepo {
  readonly repo: RepoRef
  readonly doc: RepoDoc
}

/** How a repo route addresses a repo. */
export interface RepoAddressParams {
  readonly network?: Network
  /** Identity id or DPNS name. */
  readonly owner: string
  readonly name: string
  /** `?repo=` — the `repo` document id. */
  readonly repoId?: string
}

/**
 * Resolve a repo route to a repo. Null when nothing resolves (or forge-v2 is not deployed on
 * the network). An explicit `repoId` wins over the name, and is still checked against the
 * owner the URL names.
 */
export function resolveAnyRepo(sdk: EvoSDK, params: RepoAddressParams): Promise<ResolvedRepo | null> {
  return resolveAnyRepoWith(sdk, NETWORKS[params.network ?? DEFAULT_NETWORK].v2, params)
}

/** {@link resolveAnyRepo} over explicit forge-v2 ids (a network's, or a test's). */
export async function resolveAnyRepoWith(
  sdk: EvoSDK,
  forge: ForgeIds | null,
  params: RepoAddressParams,
): Promise<ResolvedRepo | null> {
  if (forge === null) return null
  const ownerId = await resolveOwner(sdk, params.owner)
  if (ownerId === null) return null

  if (params.repoId) {
    if (!isIdentifier(params.repoId)) return null
    const doc = await readRepoById(sdk, forge, params.repoId)
    return doc !== null && doc.ownerId === ownerId ? { repo: repoRefOf(forge, doc), doc } : null
  }
  const name = normalizeRepoName(params.name)
  if (name === null) return null
  const doc = await readRepoByName(sdk, forge, ownerId, name)
  return doc === null ? null : { repo: repoRefOf(forge, doc), doc }
}
