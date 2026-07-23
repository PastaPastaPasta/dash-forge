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
import { REGISTRY_DOC, asIdentifierString, type RepoListing } from '../repo'

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
    repoContractId: asIdentifierString(d['repoContractId']),
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
    // The only index carrying `$ownerId` is `ownerName` ($ownerId, normalizedName) — there is
    // no ($ownerId, $createdAt) index to order on, and an equality-constrained field must not
    // appear in orderBy (the live-proven pattern in repo/refs.ts). Traverse by normalizedName
    // and sort newest-first client-side; the owner's listing count is small by construction.
    orderBy: [['normalizedName', 'asc']],
    limit: opts.limit ?? 50,
  })
  return documents
    .map((d) => ({
      listingId: asString(d['$id']),
      ownerId: asString(d['$ownerId']),
      name: asString(d['name']),
      normalizedName: asString(d['normalizedName']),
      repoContractId: asIdentifierString(d['repoContractId']),
      description: asString(d['description']),
      createdAt: typeof d['$createdAt'] === 'number' ? d['$createdAt'] : 0,
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** Re-export the listing type for callers that only import from view glue. */
export type { RepoListing }
