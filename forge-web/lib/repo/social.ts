/**
 * forge-v2 social reads — stars, follows and profiles in forge-collab (`forge-v2.md` §2).
 *
 * `star` and `follow` are `indexOnly`: their countable indexes give star, follower and
 * following counts in O(1). A star is keyed by the `repo` document id.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { ForgeIds } from '../deployments'
import { countDocuments, queryAllDocuments, queryDocuments } from '../sdk'
import { DOC, asIdentifierString, str, type RepoRef } from './contract'

/** A repo's star count (`star.byRepo`, countable). */
export function readStarCount(sdk: EvoSDK, forge: ForgeIds, repoId: string): Promise<number> {
  return countDocuments(sdk, {
    dataContractId: forge.collab,
    documentTypeName: DOC.star,
    where: [['repoId', '==', repoId]],
  })
}

/**
 * Who starred a repo. `star` is `indexOnly` with no `$createdAt` in its indexes (`forge-v2.md`
 * §9), so the list is in index order, not newest first, and carries no star time.
 */
export async function readStargazers(
  sdk: EvoSDK,
  forge: ForgeIds,
  repoId: string,
  limit = 100,
): Promise<string[]> {
  const docs = await queryDocuments(sdk, {
    dataContractId: forge.collab,
    documentTypeName: DOC.star,
    where: [['repoId', '==', repoId]],
    limit,
  })
  return docs
    .map((d) => str(d, '$ownerId'))
    .filter((id) => id !== '')
}

/**
 * A repo's issue and pull-request totals, from the `number` indexes (`issue.number`,
 * `patch.number`, rangeCountable): O(1) and proof-checked, so a tab count is never a guess.
 * `null` for a count that could not be read.
 */
export async function readTargetCounts(
  sdk: EvoSDK,
  forge: ForgeIds,
  repoId: string,
): Promise<{ issues: number | null; pulls: number | null }> {
  const count = (type: string): Promise<number | null> =>
    countDocuments(sdk, {
      dataContractId: forge.collab,
      documentTypeName: type,
      where: [['repoId', '==', repoId]],
    }).catch(() => null)
  const [issues, pulls] = await Promise.all([count(DOC.issue), count(DOC.patch)])
  return { issues, pulls }
}

/**
 * What anyone can see of a private repo (`ux-dx-spec.md` §6.3, `forge-v2.md` §5): its member
 * count, its last activity (the newest ref update's time) and its stored size. Nothing here
 * decrypts anything: sizes and timing are public by design.
 */
export async function readPublicRepoFacts(
  sdk: EvoSDK,
  repo: RepoRef,
): Promise<{ members: number; lastActivity: number | null; storedBytes: number }> {
  const scoped = (type: string, orderBy: readonly (readonly [string, 'asc' | 'desc'])[], limit?: number) => ({
    dataContractId: repo.forge.core,
    documentTypeName: type,
    where: [['repoId', '==', repo.repoId]] as const,
    orderBy,
    ...(limit !== undefined ? { limit } : {}),
  })
  const [maintainers, writers, newest, manifests] = await Promise.all([
    queryAllDocuments(sdk, scoped(DOC.maintainer, [['memberId', 'asc']])),
    queryAllDocuments(sdk, scoped(DOC.writer, [['memberId', 'asc']])),
    queryDocuments(sdk, scoped(DOC.refUpdate, [['$createdAt', 'desc']], 1)),
    queryAllDocuments(sdk, scoped(DOC.packManifest, [['$createdAt', 'asc']])),
  ])
  const at = newest[0]?.['$createdAt']
  const sizes = new Map<string, number>()
  for (const m of manifests) {
    const hash = str(m, 'packHash')
    const size = typeof m['sizeBytes'] === 'number' ? m['sizeBytes'] : Number(m['sizeBytes'] ?? 0)
    if (hash !== '' && Number.isFinite(size)) sizes.set(hash, size)
  }
  return {
    members: new Set([...maintainers, ...writers].map((d) => asIdentifierString(d['memberId']))).size,
    lastActivity: typeof at === 'number' ? at : null,
    storedBytes: [...sizes.values()].reduce((a, b) => a + b, 0),
  }
}

/** Follower count (`follow.byTarget`) and following count (`follow.byOwner`), both countable. */
export async function readFollowCounts(
  sdk: EvoSDK,
  forge: ForgeIds,
  identityId: string,
): Promise<{ followers: number | null; following: number | null }> {
  const [followers, following] = await Promise.all([
    countDocuments(sdk, {
      dataContractId: forge.collab,
      documentTypeName: DOC.follow,
      where: [['identityId', '==', identityId]],
    }).catch(() => null),
    countDocuments(sdk, {
      dataContractId: forge.collab,
      documentTypeName: DOC.follow,
      where: [['$ownerId', '==', identityId]],
    }).catch(() => null),
  ])
  return { followers, following }
}
