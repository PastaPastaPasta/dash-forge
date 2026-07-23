/**
 * Repo resolution — registry lookup → repo contract (data-contracts §1).
 *
 * Discovery lives in the registry (`repoListing`); operational state lives in the repo
 * contract. Listing-authenticity rule (§4): a listing is believed only if the repo
 * contract's owner == the listing's `$ownerId`; among multiple listings naming the same
 * contract, the repo-owner's newest is canonical.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS, type Network } from '../constants'
import { queryDocumentsWithProof, type PlainDocument } from '../sdk'
import { REGISTRY_DOC, asIdentifierString, type RepoRef } from './contract'

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

/** A resolved repo listing (registry row). */
export interface RepoListing {
  readonly listingId: string
  readonly ownerId: string
  readonly name: string
  readonly normalizedName: string
  readonly repoContractId: string
  readonly description: string
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
 * Resolve a repo to its contract, verifying listing authenticity. Returns the {@link RepoRef}
 * only if the repo contract's owner matches the listing owner (§4).
 */
export async function resolveRepo(
  sdk: EvoSDK,
  params: {
    readonly network?: Network
    readonly registryContractId?: string
    readonly ownerId: string
    readonly name: string
  },
): Promise<RepoRef | null> {
  const registryId =
    params.registryContractId ?? NETWORKS[params.network ?? 'testnet'].registryContractId
  if (registryId === null) throw new Error('no registry contract id configured for this network')

  const listing = await resolveRepoListing(sdk, registryId, params.ownerId, params.name)
  if (listing === null) return null

  const contractOwner = await fetchContractOwner(sdk, listing.repoContractId)
  if (contractOwner === null || contractOwner !== listing.ownerId) {
    // Listing points at a contract it does not own — inauthentic, reject (§4).
    return null
  }
  return { contractId: listing.repoContractId, ownerId: listing.ownerId }
}

/** Resolve straight from a known repo contract id (skips the registry name lookup). */
export async function resolveRepoByContractId(
  sdk: EvoSDK,
  contractId: string,
): Promise<RepoRef | null> {
  const ownerId = await fetchContractOwner(sdk, contractId)
  if (ownerId === null) return null
  return { contractId, ownerId }
}
