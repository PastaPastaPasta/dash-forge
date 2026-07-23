/**
 * Discovery reads (view glue) — the registry-backed repo feed for the landing page.
 *
 * Lists recent `repoListing` rows from the global registry (newest first). Listing
 * authenticity (repo-contract owner == listing owner, §4) is verified lazily on the repo
 * home page via {@link resolveRepo}; the feed itself is a discovery surface, clearly a
 * registry index rather than a proof-of-ownership claim.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS, type Network } from '../constants'
import { queryDocumentsWithProof } from '../sdk'
import { REGISTRY_DOC, type RepoListing } from '../repo'

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** A registry repo row for the discovery feed. */
export interface DiscoveredRepo {
  readonly listingId: string
  readonly ownerId: string
  readonly name: string
  readonly normalizedName: string
  readonly repoContractId: string
  readonly description: string
  readonly createdAt: number
}

/** List the newest repo listings from the registry. */
export async function listRecentRepos(
  sdk: EvoSDK,
  opts: { network?: Network; registryContractId?: string; limit?: number } = {},
): Promise<DiscoveredRepo[]> {
  const registryId =
    opts.registryContractId ?? NETWORKS[opts.network ?? 'testnet'].registryContractId
  if (registryId === null) throw new Error('no registry contract id configured for this network')

  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: registryId,
    documentTypeName: REGISTRY_DOC.repoListing,
    orderBy: [['$createdAt', 'desc']],
    limit: opts.limit ?? 30,
  })
  return documents.map((d) => ({
    listingId: asString(d['$id']),
    ownerId: asString(d['$ownerId']),
    name: asString(d['name']),
    normalizedName: asString(d['normalizedName']),
    repoContractId: asString(d['repoContractId']),
    description: asString(d['description']),
    createdAt: typeof d['$createdAt'] === 'number' ? d['$createdAt'] : 0,
  }))
}

/** Repos owned by an identity (for the profile page). */
export async function listReposByOwner(
  sdk: EvoSDK,
  ownerId: string,
  opts: { network?: Network; registryContractId?: string; limit?: number } = {},
): Promise<DiscoveredRepo[]> {
  const registryId =
    opts.registryContractId ?? NETWORKS[opts.network ?? 'testnet'].registryContractId
  if (registryId === null) throw new Error('no registry contract id configured for this network')

  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: registryId,
    documentTypeName: REGISTRY_DOC.repoListing,
    where: [['$ownerId', '==', ownerId]],
    orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
    limit: opts.limit ?? 50,
  })
  return documents.map((d) => ({
    listingId: asString(d['$id']),
    ownerId: asString(d['$ownerId']),
    name: asString(d['name']),
    normalizedName: asString(d['normalizedName']),
    repoContractId: asString(d['repoContractId']),
    description: asString(d['description']),
    createdAt: typeof d['$createdAt'] === 'number' ? d['$createdAt'] : 0,
  }))
}

/** Re-export the listing type for callers that only import from view glue. */
export type { RepoListing }
