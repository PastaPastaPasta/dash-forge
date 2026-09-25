/**
 * forge-v2 social reads — stars, follows and profiles in forge-collab (`forge-v2.md` §2).
 *
 * `star` and `follow` are `indexOnly`: their countable indexes give star, follower and
 * following counts in O(1), and "did I star this" is one lookup. A star is keyed by the
 * `repo` document id, not by a registry listing. v1 repos keep the registry reads in
 * `./collab`.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { ForgeIds } from '../deployments'
import { countDocuments, queryDocuments } from '../sdk'
import { V2_DOC, asIdentifierString } from './contract'

/** A repo's star count (`star.byRepo`, countable). */
export function readV2StarCount(sdk: EvoSDK, forge: ForgeIds, repoId: string): Promise<number> {
  return countDocuments(sdk, {
    dataContractId: forge.collab,
    documentTypeName: V2_DOC.star,
    where: [['repoId', '==', repoId]],
  })
}

/** Star counts for several repos in one read each, in parallel (small N: a page of cards). */
export async function readV2StarCounts(
  sdk: EvoSDK,
  forge: ForgeIds,
  repoIds: readonly string[],
): Promise<Map<string, number | null>> {
  const entries = await Promise.all(
    repoIds.map(async (id) => [id, await readV2StarCount(sdk, forge, id).catch(() => null)] as const),
  )
  return new Map(entries)
}

/**
 * Who starred a repo. `star` is `indexOnly` with no `$createdAt` in its indexes (`forge-v2.md`
 * §9), so the list is in index order, not newest first, and carries no star time.
 */
export async function readV2Stargazers(
  sdk: EvoSDK,
  forge: ForgeIds,
  repoId: string,
  limit = 100,
): Promise<string[]> {
  const docs = await queryDocuments(sdk, {
    dataContractId: forge.collab,
    documentTypeName: V2_DOC.star,
    where: [['repoId', '==', repoId]],
    limit,
  })
  return docs
    .map((d) => (typeof d['$ownerId'] === 'string' ? d['$ownerId'] : ''))
    .filter((id) => id !== '')
}

/** The repo ids an identity starred (`star.byOwner`). */
export async function readV2StarredRepoIds(
  sdk: EvoSDK,
  forge: ForgeIds,
  identityId: string,
  limit = 100,
): Promise<string[]> {
  const docs = await queryDocuments(sdk, {
    dataContractId: forge.collab,
    documentTypeName: V2_DOC.star,
    where: [['$ownerId', '==', identityId]],
    limit,
  })
  return docs.map((d) => asIdentifierString(d['repoId'])).filter((id) => id !== '')
}

/** Follower count (`follow.byTarget`) and following count (`follow.byOwner`), both countable. */
export async function readV2FollowCounts(
  sdk: EvoSDK,
  forge: ForgeIds,
  identityId: string,
): Promise<{ followers: number | null; following: number | null }> {
  const [followers, following] = await Promise.all([
    countDocuments(sdk, {
      dataContractId: forge.collab,
      documentTypeName: V2_DOC.follow,
      where: [['identityId', '==', identityId]],
    }).catch(() => null),
    countDocuments(sdk, {
      dataContractId: forge.collab,
      documentTypeName: V2_DOC.follow,
      where: [['$ownerId', '==', identityId]],
    }).catch(() => null),
  ])
  return { followers, following }
}

/** A forge-collab `profile` (one per identity), flattened. */
export interface V2Profile {
  readonly displayName: string
  readonly bio: string
  readonly links: readonly string[]
}

/** An identity's forge-collab profile, or null when it has none. */
export async function readV2Profile(
  sdk: EvoSDK,
  forge: ForgeIds,
  identityId: string,
): Promise<V2Profile | null> {
  const docs = await queryDocuments(sdk, {
    dataContractId: forge.collab,
    documentTypeName: V2_DOC.profile,
    where: [['$ownerId', '==', identityId]],
    limit: 1,
  })
  const d = docs[0]
  if (d === undefined) return null
  const links = d['links']
  return {
    displayName: typeof d['displayName'] === 'string' ? d['displayName'] : '',
    bio: typeof d['bio'] === 'string' ? d['bio'] : '',
    links: Array.isArray(links) ? links.filter((l): l is string => typeof l === 'string') : [],
  }
}
