/**
 * Repo resolution — `(owner, name)` → a `RepoRef`.
 *
 * Order (the forge-v2 client migration, `forge-v2.md` §6: "the `repo` document is the
 * listing"):
 *
 *  1. **forge-v2** — on a network with a v2 deployment, the `repo` document with unique
 *     `($ownerId, name)` in forge-core. The repo is its own listing; no authenticity check is
 *     needed.
 *  2. **v1** — the registry `repoListing` → repo contract, believed only if the contract's
 *     owner is the listing's `$ownerId` (data-contracts §4); the repo-owner's newest listing
 *     is canonical. v1 repos are read-only in the web app's v2 world.
 *
 * `?repo=<repoId>` pins a v2 repo and `?contract=<id>` a v1 contract, skipping the name
 * lookup. The owner may be an identity id or a DPNS name (`alice` / `alice.dash`).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Decode } from '../auth/base58'
import { DEFAULT_NETWORK, NETWORKS, requireRegistryContractId, type Network } from '../constants'
import type { ForgeIds } from '../deployments'
import { normalizeRepoName, type Visibility } from '../rules/v2'
import { queryDocumentsWithProof, type PlainDocument, type WhereClause } from '../sdk'
import {
  REGISTRY_DOC,
  V2_DOC,
  asIdentifierString,
  stringArray,
  type V1RepoRef,
  type V2RepoRef,
} from './contract'

interface DataContractLike {
  ownerId?: () => unknown
  getOwnerId?: () => unknown
  toJSON?: () => unknown
}
interface ContractsFacadeLike {
  fetch: (contractId: string) => Promise<unknown>
}
interface SdkContractsLike {
  contracts: ContractsFacadeLike
}
interface DpnsFacadeLike {
  dpns: { resolveName(name: string): Promise<string | undefined> }
}

/** A resolved repo listing (registry row). */
export interface RepoListing {
  readonly listingId: string
  readonly ownerId: string
  readonly name: string
  readonly normalizedName: string
  readonly repoContractId: string
  readonly description: string
}

/** A forge-v2 `repo` document, flattened. */
export interface V2RepoDoc {
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

function toListing(doc: PlainDocument): RepoListing {
  return {
    listingId: asString(doc['$id']),
    ownerId: asString(doc['$ownerId']),
    name: asString(doc['name']),
    normalizedName: asString(doc['normalizedName']),
    repoContractId: asIdentifierString(doc['repoContractId']),
    description: asString(doc['description']),
  }
}

/** Flatten a forge-core `repo` document. */
export function toV2RepoDoc(doc: PlainDocument): V2RepoDoc {
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

/** The {@link V2RepoRef} a `repo` document addresses. */
export function v2RefOf(forge: ForgeIds, repo: V2RepoDoc): V2RepoRef {
  return {
    kind: 'v2',
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

/** The repo contract's owner identity (base58), fetched + normalized from the contract. */
export async function fetchContractOwner(sdk: EvoSDK, contractId: string): Promise<string | null> {
  const contract = await (sdk as unknown as SdkContractsLike).contracts.fetch(contractId)
  if (contract == null) return null
  const c = contract as DataContractLike
  if (typeof c.ownerId === 'function') {
    const o = asString(c.ownerId())
    if (o) return o
  }
  if (typeof c.getOwnerId === 'function') {
    const o = asString(c.getOwnerId())
    if (o) return o
  }
  if (typeof c.toJSON === 'function') {
    const j = c.toJSON()
    if (j && typeof j === 'object') {
      const owner = (j as Record<string, unknown>)['ownerId']
      const o = asString(owner)
      if (o) return o
    }
  }
  return null
}

/** Look up a repo listing by `($ownerId, normalizedName)` in the registry. */
export async function resolveRepoListing(
  sdk: EvoSDK,
  registryContractId: string,
  ownerId: string,
  normalizedName: string,
): Promise<RepoListing | null> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: registryContractId,
    documentTypeName: REGISTRY_DOC.repoListing,
    where: [
      ['$ownerId', '==', ownerId],
      ['normalizedName', '==', normalizedName],
    ],
    limit: 1,
  })
  const doc = documents[0]
  return doc === undefined ? null : toListing(doc)
}

/**
 * Resolve a repo listing AND verify listing authenticity (§4): the repo contract's owner
 * must equal the listing's `$ownerId`, else the listing points at a contract it does not
 * own and is rejected. Returns both the {@link RepoRef} and the listing (whose id feeds
 * star reads) so callers need only one registry round-trip.
 */
export async function resolveRepoWithListing(
  sdk: EvoSDK,
  registryContractId: string,
  ownerId: string,
  name: string,
): Promise<{ repo: V1RepoRef; listing: RepoListing } | null> {
  const listing = await resolveRepoListing(sdk, registryContractId, ownerId, name)
  if (listing === null) return null

  const contractOwner = await fetchContractOwner(sdk, listing.repoContractId)
  if (contractOwner === null || contractOwner !== listing.ownerId) {
    // Listing points at a contract it does not own — inauthentic, reject (§4).
    return null
  }
  return {
    repo: {
      kind: 'v1',
      contractId: listing.repoContractId,
      ownerId: listing.ownerId,
      name: listing.name || listing.normalizedName,
    },
    listing,
  }
}

/** The one forge-v2 `repo` document `where` selects, or null. */
async function readV2Repo(
  sdk: EvoSDK,
  forge: ForgeIds,
  where: readonly WhereClause[],
): Promise<V2RepoDoc | null> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: forge.core,
    documentTypeName: V2_DOC.repo,
    where,
    limit: 1,
  })
  const doc = documents[0]
  return doc === undefined ? null : toV2RepoDoc(doc)
}

/** The forge-v2 `repo` document `($ownerId, name)`, or null. */
function readV2RepoByName(sdk: EvoSDK, forge: ForgeIds, ownerId: string, name: string): Promise<V2RepoDoc | null> {
  return readV2Repo(sdk, forge, [
    ['$ownerId', '==', ownerId],
    ['name', '==', name],
  ])
}

/** The forge-v2 `repo` document with id `repoId`, or null. */
export function readV2RepoById(sdk: EvoSDK, forge: ForgeIds, repoId: string): Promise<V2RepoDoc | null> {
  return readV2Repo(sdk, forge, [['$id', '==', repoId]])
}

/** What resolved: a forge-v2 repo with its document, or a v1 repo with its listing. */
export type ResolvedRepo =
  | { readonly repo: V2RepoRef; readonly doc: V2RepoDoc }
  | { readonly repo: V1RepoRef; readonly listing: RepoListing | null }

/** How a repo route addresses a repo. */
export interface RepoAddressParams {
  readonly network?: Network
  /** Identity id or DPNS name. */
  readonly owner: string
  readonly name: string
  /** `?repo=` — a forge-v2 repo id. */
  readonly repoId?: string
  /** `?contract=` — a v1 repo contract id. */
  readonly contractId?: string
}

/**
 * Resolve a repo route to a repo: forge-v2 first, then the v1 registry. Null when nothing
 * authentic resolves. An explicit `repoId` / `contractId` wins over the name, and is still
 * checked against the owner the URL names.
 */
export function resolveAnyRepo(sdk: EvoSDK, params: RepoAddressParams): Promise<ResolvedRepo | null> {
  const config = NETWORKS[params.network ?? DEFAULT_NETWORK]
  return resolveAnyRepoWith(sdk, { forge: config.v2, registryId: config.registryContractId }, params)
}

/** {@link resolveAnyRepo} over explicit deployment ids (a network's, or a test's). */
export async function resolveAnyRepoWith(
  sdk: EvoSDK,
  deployment: { readonly forge: ForgeIds | null; readonly registryId: string | null },
  params: RepoAddressParams,
): Promise<ResolvedRepo | null> {
  const { forge, registryId } = deployment
  const ownerId = await resolveOwner(sdk, params.owner)
  if (ownerId === null) return null

  if (params.repoId) {
    if (forge === null || !isIdentifier(params.repoId)) return null
    const doc = await readV2RepoById(sdk, forge, params.repoId)
    return doc !== null && doc.ownerId === ownerId ? { repo: v2RefOf(forge, doc), doc } : null
  }
  if (params.contractId) {
    const repo = await resolveRepoByContractId(sdk, params.contractId)
    if (repo === null || repo.ownerId !== ownerId) return null
    // No listing names it: show the contract id, never a name the URL supplied.
    return { repo: { ...repo, name: params.contractId }, listing: null }
  }

  if (forge !== null) {
    const name = normalizeRepoName(params.name)
    if (name !== null) {
      const doc = await readV2RepoByName(sdk, forge, ownerId, name)
      if (doc !== null) return { repo: v2RefOf(forge, doc), doc }
    }
  }
  if (registryId === null) return null
  return resolveRepoWithListing(sdk, registryId, ownerId, params.name)
}

/**
 * Resolve a v1 repo to its contract, verifying listing authenticity. Returns the
 * {@link V1RepoRef} only if the repo contract's owner matches the listing owner (§4).
 */
export async function resolveRepo(
  sdk: EvoSDK,
  params: {
    readonly network?: Network
    readonly registryContractId?: string
    readonly ownerId: string
    readonly name: string
  },
): Promise<V1RepoRef | null> {
  const registryId =
    params.registryContractId ?? requireRegistryContractId(params.network ?? DEFAULT_NETWORK)

  const resolved = await resolveRepoWithListing(sdk, registryId, params.ownerId, params.name)
  return resolved === null ? null : resolved.repo
}

/** Resolve straight from a known v1 repo contract id (skips the registry name lookup). */
export async function resolveRepoByContractId(
  sdk: EvoSDK,
  contractId: string,
): Promise<V1RepoRef | null> {
  const ownerId = await fetchContractOwner(sdk, contractId)
  if (ownerId === null) return null
  return { kind: 'v1', contractId, ownerId, name: '' }
}
