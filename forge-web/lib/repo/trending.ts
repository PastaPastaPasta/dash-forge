/**
 * Trending (platform-parity-spec §4.3, §4.4): a star can also write a `starBeat`, a forge-collab
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
const browserStore = (): Store | null => (typeof localStorage === 'undefined' ? null : localStorage)

/** The stored preference, or {@link TRENDING_DEFAULT}. */
export function trendingPref(storage: Store | null = browserStore()): boolean {
  const raw = storage?.getItem(TRENDING_PREF_KEY) ?? null
  return raw === 'on' ? true : raw === 'off' ? false : TRENDING_DEFAULT
}

export function setTrendingPref(on: boolean, storage: Store | null = browserStore()): void {
  storage?.setItem(TRENDING_PREF_KEY, on ? 'on' : 'off')
}

/** Which window a trending read selects: the trailing week (`oldest`) or today (`newest`). */
export type TrendingWindow = 'week' | 'today'

/** The top repos by new stargazers in the window: `starBeat.byWeek`, proved. */
export function readTrending(sdk: EvoSDK, forge: ForgeIds, window: TrendingWindow, limit = 25): Promise<RankedPage> {
  return rankedDocuments(sdk, {
    dataContractId: forge.collab,
    documentTypeName: DOC.starBeat,
    groupBy: 'repoId',
    limit,
    timeRange: { field: '$createdAt', selector: window === 'week' ? 'oldest' : 'newest' },
  })
}

/** The most starred repos of all time: `star.byRepo`, proved. */
export function readMostStarred(sdk: EvoSDK, forge: ForgeIds, limit = 25): Promise<RankedPage> {
  return rankedDocuments(sdk, { dataContractId: forge.collab, documentTypeName: DOC.star, groupBy: 'repoId', limit })
}

/** The most followed identities: `follow.byTarget`, proved. */
export function readMostFollowed(sdk: EvoSDK, forge: ForgeIds, limit = 25): Promise<RankedPage> {
  return rankedDocuments(sdk, { dataContractId: forge.collab, documentTypeName: DOC.follow, groupBy: 'identityId', limit })
}
