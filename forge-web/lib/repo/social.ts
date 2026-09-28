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
  { retryMs = 1500 }: { retryMs?: number } = {},
): Promise<{ issues: number | null; pulls: number | null }> {
  const key = `${forge.collab}:${repoId}`
  const count = async (type: 'issue' | 'patch'): Promise<number | null> => {
    const read = (): Promise<number | null> =>
      countDocuments(sdk, {
        dataContractId: forge.collab,
        documentTypeName: DOC[type],
        where: [['repoId', '==', repoId]],
      }).catch(() => null)
    // Read-after-write: a node a block behind still counts without the issue or PR this browser
    // just created. Re-read it a few times while it is below what that write proves (L-37).
    const floor = createdFloor.get(`${key}:${type}`) ?? 0
    let n = await read()
    for (let i = 0; n !== null && n < floor && i < FLOOR_RETRIES; i++) {
      await new Promise((r) => setTimeout(r, retryMs))
      n = await read()
    }
    if (n !== null) {
      lastCount.set(`${key}:${type}`, n)
      if (n >= floor) createdFloor.delete(`${key}:${type}`)
    }
    return n
  }
  const [issues, pulls] = await Promise.all([count('issue'), count('patch')])
  return { issues, pulls }
}

/** How often a count below a write's floor is read again (about 6 s: a few blocks). */
const FLOOR_RETRIES = 4
/** The last count read per `collab:repoId:type`, and the least a create by this browser proves. */
const lastCount = new Map<string, number>()
const createdFloor = new Map<string, number>()

/**
 * This browser created an issue or PR in `repo`: its total is now at least one more than the
 * last count read (neither type can be deleted, `canBeDeleted: false`), so the next count read
 * waits for a node that has the new document rather than showing a stale total.
 */
export function noteTargetCreated(repo: RepoRef, type: 'issue' | 'patch'): void {
  const key = `${repo.forge.collab}:${repo.repoId}:${type}`
  createdFloor.set(key, Math.max(createdFloor.get(key) ?? 0, (lastCount.get(key) ?? 0) + 1))
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

/** Which side of an identity's follow graph a list shows. */
export type FollowSide = 'followers' | 'following'

/** One page of a follow list, and the cursor that continues it (null: this was the last page). */
export interface FollowPage {
  readonly ids: readonly string[]
  readonly next: string | null
}

/** The all-zero identifier: every real identity id sorts after it, so it opens a keyset walk. */
const FIRST_ID = '11111111111111111111111111111111'

/** Rows a follow list reads per page. */
const FOLLOW_PAGE = 50

/**
 * One page of who follows `identityId` (`follow.byTarget`, whose terminal is `$ownerId`) or
 * whom it follows (`follow.byOwner`, terminal `identityId`). `follow` is `indexOnly`, so a
 * page cannot continue from a `startAfter` document id (Drive refuses it: the synthesized id is
 * a one-way hash); it continues with a range on the index's terminal, ordered by it
 * (keyset pagination, `index-only-document-types.md`). The list is in identity-id order and
 * carries no follow time. Proof-verified, like every read.
 */
export async function readFollowPage(
  sdk: EvoSDK,
  forge: ForgeIds,
  identityId: string,
  side: FollowSide,
  after: string | null = null,
  limit = FOLLOW_PAGE,
): Promise<FollowPage> {
  const [pinned, terminal] = side === 'followers' ? (['identityId', '$ownerId'] as const) : (['$ownerId', 'identityId'] as const)
  const docs = await queryDocuments(sdk, {
    dataContractId: forge.collab,
    documentTypeName: DOC.follow,
    where: [
      [pinned, '==', identityId],
      [terminal, '>', after ?? FIRST_ID],
    ],
    orderBy: [[terminal, 'asc']],
    limit,
  })
  const ids = docs.map((d) => str(d, terminal)).filter((id) => id !== '')
  return { ids, next: docs.length < limit ? null : ids[ids.length - 1] ?? null }
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
