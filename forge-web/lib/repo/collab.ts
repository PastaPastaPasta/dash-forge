/**
 * Collaborators + social reads (data-contracts §2.1, §3).
 *
 * Collaborators ARE the token balances: an identity holding an unfrozen WRITE / MAINTAIN
 * balance is a collaborator. Platform has no "list all holders" query, so the candidate
 * set is discovered (distinct pushers + the repo owner) and then balance/freeze-checked.
 * Star / follower / following counts are O(1) count-tree reads on the registry.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS, type Network } from '../constants'
import { countDocuments, skipScanDistinct, base64ToBytes } from '../sdk'
import { REGISTRY_DOC, TOKEN_POSITION, DOC, type RepoRef } from './contract'

interface TokensFacadeLike {
  calculateId: (contractId: string, tokenPosition: number) => Promise<string>
  balances: (identityIds: string[], tokenId: string) => Promise<Map<string, bigint>>
  identitiesTokenInfos: (identityIds: string[], tokenId: string) => Promise<Map<string, unknown>>
}
interface SdkTokensLike {
  tokens: TokensFacadeLike
}

/** One collaborator row (the on-chain ACL). */
export interface Collaborator {
  readonly identity: string
  /** Holds a (nonzero) WRITE balance. */
  readonly write: boolean
  /** Holds a (nonzero) MAINTAIN balance. */
  readonly maintain: boolean
  /** Frozen on either token (suspended — cannot spend at consensus). */
  readonly frozen: boolean
}

/** Derive the WRITE / MAINTAIN token ids for a repo contract. */
export async function repoTokenIds(
  sdk: EvoSDK,
  repo: RepoRef,
): Promise<{ write: string; maintain: string }> {
  const tokens = (sdk as unknown as SdkTokensLike).tokens
  const [write, maintain] = await Promise.all([
    tokens.calculateId(repo.contractId, TOKEN_POSITION.write),
    tokens.calculateId(repo.contractId, TOKEN_POSITION.maintain),
  ])
  return { write, maintain }
}

/**
 * Discover candidate collaborator identities: the distinct pushers (distinct `$ownerId`
 * across `refUpdate`) plus the repo owner. Platform cannot enumerate token holders, so this
 * candidate set bounds the balance lookups.
 */
export async function candidateCollaborators(sdk: EvoSDK, repo: RepoRef): Promise<string[]> {
  const pushers = await skipScanDistinct(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.refUpdate,
    keyField: '$ownerId',
    maxKeys: 500,
  })
  return [...new Set([repo.ownerId, ...pushers])]
}

function isFrozen(info: unknown): boolean {
  if (info != null && typeof info === 'object') {
    const rec = info as Record<string, unknown>
    if (rec['frozen'] === true) return true
    const status = rec['frozenStatus'] ?? rec['status']
    if (typeof status === 'string' && status.toLowerCase().includes('frozen')) return true
  }
  return false
}

/**
 * The collaborator list: balance + freeze-check every candidate against both tokens.
 * `candidates` defaults to {@link candidateCollaborators}. Returns only identities that
 * hold at least one of the two tokens.
 */
export async function readCollaborators(
  sdk: EvoSDK,
  repo: RepoRef,
  candidates?: readonly string[],
): Promise<Collaborator[]> {
  const ids = candidates ? [...candidates] : await candidateCollaborators(sdk, repo)
  if (ids.length === 0) return []
  const tokens = (sdk as unknown as SdkTokensLike).tokens
  const { write, maintain } = await repoTokenIds(sdk, repo)

  const [writeBal, maintainBal, writeInfo, maintainInfo] = await Promise.all([
    tokens.balances(ids, write),
    tokens.balances(ids, maintain),
    tokens.identitiesTokenInfos(ids, write),
    tokens.identitiesTokenInfos(ids, maintain),
  ])

  const out: Collaborator[] = []
  for (const id of ids) {
    const hasWrite = (writeBal.get(id) ?? 0n) > 0n
    const hasMaintain = (maintainBal.get(id) ?? 0n) > 0n
    if (!hasWrite && !hasMaintain) continue
    const frozen = isFrozen(writeInfo.get(id)) || isFrozen(maintainInfo.get(id))
    out.push({ identity: id, write: hasWrite, maintain: hasMaintain, frozen })
  }
  return out
}

// ---------------------------------------------------------------------------
// Social counts (registry count trees — O(1))
// ---------------------------------------------------------------------------

function registryId(network: Network | undefined, override?: string): string {
  const id = override ?? NETWORKS[network ?? 'testnet'].registryContractId
  if (id === null) throw new Error('no registry contract id configured')
  return id
}

/** Star count for a repo listing (countable `star(listingId)`). `listingId` is base58. */
export async function readStarCount(
  sdk: EvoSDK,
  listingId: string,
  opts: { network?: Network; registryContractId?: string } = {},
): Promise<number> {
  return countDocuments(sdk, {
    dataContractId: registryId(opts.network, opts.registryContractId),
    documentTypeName: REGISTRY_DOC.star,
    where: [['listingId', '==', listingId]],
  })
}

/** Follower count for an identity (countable `follow(identityId)`). */
export async function readFollowerCount(
  sdk: EvoSDK,
  identityId: string,
  opts: { network?: Network; registryContractId?: string } = {},
): Promise<number> {
  return countDocuments(sdk, {
    dataContractId: registryId(opts.network, opts.registryContractId),
    documentTypeName: REGISTRY_DOC.follow,
    where: [['identityId', '==', identityId]],
  })
}

/** Following count for an identity (countable `follow($ownerId)`). */
export async function readFollowingCount(
  sdk: EvoSDK,
  identityId: string,
  opts: { network?: Network; registryContractId?: string } = {},
): Promise<number> {
  return countDocuments(sdk, {
    dataContractId: registryId(opts.network, opts.registryContractId),
    documentTypeName: REGISTRY_DOC.follow,
    where: [['$ownerId', '==', identityId]],
  })
}

/** Whether the given base64 token-balance encoding is nonzero (utility for callers). */
export function balanceIsNonzero(b64: string): boolean {
  const bytes = base64ToBytes(b64)
  return bytes.some((b) => b !== 0)
}
