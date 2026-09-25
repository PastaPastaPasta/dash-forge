/**
 * forge-v2 social reads — stars, follows and profiles in forge-collab (`forge-v2.md` §2).
 *
 * `star` and `follow` are `indexOnly`: their countable indexes give star, follower and
 * following counts in O(1). A star is keyed by the `repo` document id, not by a registry
 * listing. v1 repos keep the registry reads in
 * `./collab`.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { ForgeIds } from '../deployments'
import { countDocuments, queryDocuments } from '../sdk'
import { V2_DOC, str } from './contract'

/** A repo's star count (`star.byRepo`, countable). */
export function readV2StarCount(sdk: EvoSDK, forge: ForgeIds, repoId: string): Promise<number> {
  return countDocuments(sdk, {
    dataContractId: forge.collab,
    documentTypeName: V2_DOC.star,
    where: [['repoId', '==', repoId]],
  })
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
    .map((d) => str(d, '$ownerId'))
    .filter((id) => id !== '')
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
