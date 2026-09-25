/**
 * Discovery reads (view glue) — the repo feeds for the landing page and profiles.
 *
 * - **forge-v2**: a repo IS a `repo` document in forge-core, so the feed is one proof-checked
 *   query on the `$createdAt` index, and the star and issue counts ride along in the same
 *   verified round trip (`documents.composite`: counts over forge-collab's `star.byRepo` and
 *   `issue.number` indexes, bound to the page's repo ids). A profile lists the repos an
 *   identity owns (`($ownerId, name)`) and the ones it is a member of (`memberId` indexes).
 * - **v1**: recent `repoListing` rows from the global registry. Listing authenticity
 *   (repo-contract owner == listing owner, §4) is verified lazily on the repo home page; the
 *   feed is a discovery surface, a registry index rather than a proof-of-ownership claim.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, NETWORKS, type Network } from '../constants'
import type { ForgeIds } from '../deployments'
import type { Role } from '../rules/v2'
import { normalizeDocument, queryDocumentsWithProof, type PlainDocument } from '../sdk'
import {
  DOC,
  REGISTRY_DOC,
  V2_DOC,
  readMemberRepoIds,
  toV2RepoDoc,
  type RepoListing,
  type V2RepoDoc,
} from '../repo'

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** A repo row for the discovery feed and profiles — v1 listing or forge-v2 repo. */
export interface DiscoveredRepo {
  readonly kind: 'v1' | 'v2'
  /** Stable row key: the v1 listing id or the v2 repo id. */
  readonly key: string
  readonly ownerId: string
  /** Display name (v1: the listing's; v2: the repo name). */
  readonly name: string
  /** The URL segment that addresses it (v1 `normalizedName`, v2 `name`). */
  readonly slug: string
  readonly description: string
  readonly createdAt: number
  /** forge-v2 only. */
  readonly visibility?: 'public' | 'private'
  /** forge-v2: provable counts, or null when not read. */
  readonly stars?: number | null
  readonly issues?: number | null
  /** Profile pages: the viewer's role in a repo it does not own. */
  readonly role?: Role
}

function fromListing(d: PlainDocument): DiscoveredRepo {
  return {
    kind: 'v1',
    key: asString(d['$id']),
    ownerId: asString(d['$ownerId']),
    name: asString(d['name']) || asString(d['normalizedName']),
    slug: asString(d['normalizedName']) || asString(d['name']),
    description: asString(d['description']),
    createdAt: typeof d['$createdAt'] === 'number' ? d['$createdAt'] : 0,
  }
}

function fromV2(doc: V2RepoDoc, counts?: { stars?: number | null; issues?: number | null }): DiscoveredRepo {
  return {
    kind: 'v2',
    key: doc.repoId,
    ownerId: doc.ownerId,
    name: doc.displayName || doc.name,
    slug: doc.name,
    description: doc.description,
    createdAt: doc.createdAt,
    visibility: doc.visibility,
    stars: counts?.stars ?? null,
    issues: counts?.issues ?? null,
  }
}

interface CompositeResultLike {
  pageDocuments: unknown[]
  subResults: ({ kind: 'counts'; counts: Map<string, bigint> } | { kind: 'documents' })[]
}
interface CompositeFacadeLike {
  documents: { composite(q: unknown): Promise<CompositeResultLike> }
}

function countOf(counts: Map<string, bigint> | undefined, id: string): number | null {
  if (counts === undefined) return null
  const v = counts.get(id)
  return v === undefined ? 0 : Number(v)
}

/**
 * The newest forge-v2 repos with their star and issue counts, in ONE proof-checked round trip
 * (`documents.composite`, protocol 14). Falls back to a plain page without counts if the
 * composite surface is unavailable.
 */
async function listRecentV2Repos(
  sdk: EvoSDK,
  forge: ForgeIds,
  limit = 24,
): Promise<DiscoveredRepo[]> {
  try {
    const result = await (sdk as unknown as CompositeFacadeLike).documents.composite({
      dataContractId: forge.core,
      documentType: V2_DOC.repo,
      orderBy: [['$createdAt', 'desc']],
      limit,
      subQueries: [
        {
          dataContractId: forge.collab,
          documentType: V2_DOC.star,
          kind: 'counts',
          bind: { sourceProperty: '$id', field: 'repoId' },
        },
        {
          dataContractId: forge.collab,
          documentType: DOC.issue,
          kind: 'counts',
          bind: { sourceProperty: '$id', field: 'repoId' },
        },
      ],
    })
    const [stars, issues] = result.subResults.map((r) => (r.kind === 'counts' ? r.counts : undefined))
    return result.pageDocuments.map((raw) => {
      const doc = toV2RepoDoc(normalizeDocument(raw))
      return fromV2(doc, { stars: countOf(stars, doc.repoId), issues: countOf(issues, doc.repoId) })
    })
  } catch {
    const { documents } = await queryDocumentsWithProof(sdk, {
      dataContractId: forge.core,
      documentTypeName: V2_DOC.repo,
      orderBy: [['$createdAt', 'desc']],
      limit,
    })
    return documents.map((d) => fromV2(toV2RepoDoc(d)))
  }
}

/** The newest v1 repo listings from the registry (empty on a network without one). */
async function listRecentV1Repos(sdk: EvoSDK, network: Network, limit: number): Promise<DiscoveredRepo[]> {
  const registryId = NETWORKS[network].registryContractId
  if (registryId === null) return []
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: registryId,
    documentTypeName: REGISTRY_DOC.repoListing,
    orderBy: [['$createdAt', 'desc']],
    limit,
  })
  return documents.map(fromListing)
}

/**
 * The landing feed: forge-v2 repos first (where deployed), then v1 registry listings, each
 * newest first. A network with neither returns an empty list; the caller decides what that
 * means (it cannot happen where a registry or a v2 deployment exists).
 */
export async function listRecentRepos(
  sdk: EvoSDK,
  opts: { network?: Network; limit?: number } = {},
): Promise<{ v2: DiscoveredRepo[]; v1: DiscoveredRepo[] }> {
  const network = opts.network ?? DEFAULT_NETWORK
  const forge = NETWORKS[network].v2
  const limit = opts.limit ?? 24
  const [v2, v1] = await Promise.all([
    forge !== null ? listRecentV2Repos(sdk, forge, limit) : Promise.resolve([]),
    listRecentV1Repos(sdk, network, limit),
  ])
  return { v2, v1 }
}

/**
 * Repos an identity owns — forge-v2 `repo` documents (`($ownerId, name)` index) and v1
 * registry listings — plus, on forge-v2, repos it is a maintainer or writer of.
 */
export async function listReposByOwner(
  sdk: EvoSDK,
  ownerId: string,
  opts: { network?: Network; limit?: number } = {},
): Promise<{ owned: DiscoveredRepo[]; member: DiscoveredRepo[] }> {
  const network = opts.network ?? DEFAULT_NETWORK
  const forge = NETWORKS[network].v2
  const registryId = NETWORKS[network].registryContractId
  const limit = opts.limit ?? 50

  const v2Owned = async (): Promise<DiscoveredRepo[]> => {
    if (forge === null) return []
    const { documents } = await queryDocumentsWithProof(sdk, {
      dataContractId: forge.core,
      documentTypeName: V2_DOC.repo,
      where: [['$ownerId', '==', ownerId]],
      orderBy: [['name', 'asc']],
      limit,
    })
    return documents.map((d) => fromV2(toV2RepoDoc(d)))
  }
  const v1Owned = async (): Promise<DiscoveredRepo[]> => {
    if (registryId === null) return []
    const { documents } = await queryDocumentsWithProof(sdk, {
      dataContractId: registryId,
      documentTypeName: REGISTRY_DOC.repoListing,
      where: [['$ownerId', '==', ownerId]],
      // The only index carrying `$ownerId` is `ownerName` ($ownerId, normalizedName) — there
      // is no ($ownerId, $createdAt) index to order on. Traverse by normalizedName and sort
      // newest-first client-side; the owner's listing count is small by construction.
      orderBy: [['normalizedName', 'asc']],
      limit,
    })
    return documents.map(fromListing)
  }
  const v2Member = async (): Promise<DiscoveredRepo[]> => {
    if (forge === null) return []
    const rows = (await readMemberRepoIds(sdk, forge, ownerId)).slice(0, limit)
    if (rows.length === 0) return []
    const { documents } = await queryDocumentsWithProof(sdk, {
      dataContractId: forge.core,
      documentTypeName: V2_DOC.repo,
      where: [['$id', 'in', rows.map((r) => r.repoId)]],
      limit: rows.length,
    })
    const roleOf = new Map(rows.map((r) => [r.repoId, r.role]))
    return documents
      .map(toV2RepoDoc)
      .filter((doc) => doc.ownerId !== ownerId)
      .map((doc) => ({ ...fromV2(doc), role: roleOf.get(doc.repoId) }))
  }

  const [ownedV2, ownedV1, member] = await Promise.all([v2Owned(), v1Owned(), v2Member()])
  const newestFirst = (x: DiscoveredRepo, y: DiscoveredRepo): number => y.createdAt - x.createdAt
  return {
    owned: [...ownedV2.sort(newestFirst), ...ownedV1.sort(newestFirst)],
    member: member.sort(newestFirst),
  }
}

/** Re-export the listing type for callers that only import from view glue. */
export type { RepoListing }
