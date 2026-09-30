/**
 * Trending (platform-parity-spec §4.3, §4.4): a star can also write a `starBeat`, a forge-community
 * indexOnly document whose weekly window index ranks repos by their new stargazers. It is
 * separate from the star so an unstar always works (the star keeps no `$createdAt`), and it is
 * optional: "Count my stars toward Trending" in Settings, on by default.
 *
 * A beat is non-deletable and one per identity and repo, ever (its `byOwner` proof index); its
 * window entries expire through the index's own `ttl`. An unstar does not remove it, and a
 * later star of the same repo writes none.
 *
 * Parity: forge-core `Collab::star(repo, trending)` and `TRENDING_DEFAULT`.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { ForgeIds } from '../deployments'
import { rankedDocuments, type RankedPage } from '../sdk'
import { DOC } from './contract'

/**
 * Whether a star counts toward Trending unless the user turned it off. The owner's default
 * (2026-09-28); flip it here (and forge-core's `TRENDING_DEFAULT`) to change it.
 */
export const TRENDING_DEFAULT = true

/** The localStorage key of the preference. */
export const TRENDING_PREF_KEY = 'forge.trending.v1'

type Store = Pick<Storage, 'getItem' | 'setItem'>
function browserStore(): Store | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

/** The stored preference, or {@link TRENDING_DEFAULT}. */
export function trendingPref(storage: Store | null = browserStore()): boolean {
  const raw = storage?.getItem(TRENDING_PREF_KEY) ?? null
  if (raw === 'on') return true
  if (raw === 'off') return false
  return TRENDING_DEFAULT
}

export function setTrendingPref(on: boolean, storage: Store | null = browserStore()): void {
  storage?.setItem(TRENDING_PREF_KEY, on ? 'on' : 'off')
}

/** Which window a trending read selects: the trailing week (`oldest`) or today (`newest`). */
export type TrendingWindow = 'week' | 'today'

/** The top repos by new stargazers in the window: `starBeat.byWeek`, proved. */
export function readTrending(sdk: EvoSDK, forge: ForgeIds, span: TrendingWindow, limit = 25): Promise<RankedPage> {
  return rankedDocuments(sdk, {
    dataContractId: forge.community,
    documentTypeName: DOC.starBeat,
    groupBy: 'repoId',
    limit,
    timeRange: { field: '$createdAt', selector: span === 'week' ? 'oldest' : 'newest' },
  })
}

/** The most starred repos of all time: `star.byRepo`, proved. */
export function readMostStarred(sdk: EvoSDK, forge: ForgeIds, limit = 25): Promise<RankedPage> {
  return rankedDocuments(sdk, { dataContractId: forge.community, documentTypeName: DOC.star, groupBy: 'repoId', limit })
}

/**
 * The most forked repos: forge-core `repo.forkOf`, ranked (beta.6 fresh core). Repos that are
 * not forks form a real null group (the index is null-searchable, as ranking requires), which
 * the query returns like any other group: it is dropped here, and one more row is asked for so
 * `limit` forked repos still come back.
 */
export async function readMostForked(sdk: EvoSDK, forge: ForgeIds, limit = 25): Promise<RankedPage> {
  const page = await rankedDocuments(sdk, { dataContractId: forge.core, documentTypeName: DOC.repo, groupBy: 'forkOf', limit: limit + 1 })
  return { entries: page.entries.filter((e) => e.group !== '' && e.keyHex !== '').slice(0, limit) }
}

/** The most followed identities: `follow.byTarget`, proved. */
export function readMostFollowed(sdk: EvoSDK, forge: ForgeIds, limit = 25): Promise<RankedPage> {
  return rankedDocuments(sdk, { dataContractId: forge.community, documentTypeName: DOC.follow, groupBy: 'identityId', limit })
}
