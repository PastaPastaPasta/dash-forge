/**
 * Trending (platform-parity-spec §4.3, §4.4): a star can also write a `starBeat`, a forge-community
 * indexOnly document whose weekly window index ranks repos by their new stargazers. It is
 * separate from the star so an unstar always works (the star keeps no `$createdAt`), and it is
 * optional: "Count my stars toward Trending" in Settings, on by default.
 *
 * On a fused-star contract (RC2 C1, `star-shape.ts`) the star carries the window index itself
 * (`outlivesDelete`, so an unstar still works and leaves its window entry), there is no beat and
 * no opt-out, and everything below about beats does not apply. Readers then keep private repos
 * and owners' own stars out of Trending themselves ({@link fusedTrending}).
 *
 * A beat is non-deletable and one per identity and repo, ever (its `byOwner` proof index); its
 * window entries expire through the index's own `ttl`. An unstar does not remove it, and a
 * later star of the same repo writes none.
 *
 * Parity: forge-core `Collab::star(repo, trending)` and `TRENDING_DEFAULT`.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { ForgeIds } from '../deployments'
import { STAR_BEAT_GRID, trendingWindow, type Window } from '../rules/parity'
import { rankedDocuments, type RankedEntry, type RankedPage } from '../sdk'
import { DOC, asIdentifierString } from './contract'
import { starShape } from './star-shape'
import { hasStar } from './writes'

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

/**
 * The top repos by new stargazers in the window, proved: `starBeat.byWeek`, or `star.byWeek` on
 * a fused-star contract ({@link starShape}, RC2 C1; same window, same ranking).
 */
export async function readTrending(sdk: EvoSDK, forge: ForgeIds, span: TrendingWindow, limit = 25): Promise<RankedPage> {
  const shape = await starShape(sdk, forge)
  return rankedDocuments(sdk, {
    dataContractId: forge.community,
    documentTypeName: shape === 'fused' ? DOC.star : DOC.starBeat,
    groupBy: 'repoId',
    limit,
    timeRange: { field: '$createdAt', selector: span === 'week' ? 'oldest' : 'newest' },
  })
}

/**
 * How many ranked rows a fused-star Trending read asks for per row it shows: private repos and
 * owners' own stars are filtered after the read ({@link fusedTrending}), so it reads ahead.
 */
export const FUSED_READ_AHEAD = 2

/** What {@link fusedTrending} needs of a ranked repo (`DiscoveredRepo` has it). */
export interface TrendingRepo {
  readonly ownerId: string
  readonly visibility: 'public' | 'private'
  /** The repo document's `$createdAt`, ms. */
  readonly createdAt: number
}

/**
 * How far inside the window a repo must have been created for its owner's star to be taken out:
 * the window is computed from this device's clock, the ranked proof's from the quorum's, and a
 * clock behind by less than this cannot make an owner's star from before the window look inside it.
 */
export const SELF_STAR_CLOCK_MARGIN_MS = 15 * 60_000

/**
 * Whether the owner's star of `repo` is known to be inside `window` if it exists now: `repo` is
 * public and was created inside the window (by {@link SELF_STAR_CLOCK_MARGIN_MS}), so any star
 * of it is newer than the window's start.
 */
export function selfStarDecidable(repo: TrendingRepo, window: Window | null): boolean {
  return window !== null && repo.visibility === 'public' && repo.createdAt >= window.start + SELF_STAR_CLOCK_MARGIN_MS
}

/** How many owner-star reads {@link readOwnerStars} has in flight at once. */
const OWNER_STAR_PARALLEL = 6

/**
 * How many `star` rows the batched owner lookup asks for: the most one documents sub-query may
 * return. Fewer rows back than this means the lookup saw every star of every owner it named.
 */
export const OWNER_STAR_LOOKUP_LIMIT = 100

/**
 * What one batched read of the stars of a set of owners saw (`star.byOwner`, `$ownerId in
 * <owners>`, in the same composite as the repos: Explore's Trending costs no request for it).
 */
export interface OwnerStarLookup {
  /** The stars it returned, as `(owner id, repo id)` in base58. */
  readonly stars: readonly { readonly ownerId: string; readonly repoId: string }[]
  /**
   * Whether it returned every star of those owners: false when it hit
   * {@link OWNER_STAR_LOOKUP_LIMIT} or a row did not carry two identifiers (a shape it cannot
   * be trusted on, so no absent pair is taken as unstarred).
   */
  readonly complete: boolean
}

/** What `rows`, a `star` lookup's documents, saw of the owners' stars. */
export function ownerStarLookupOf(rows: readonly Record<string, unknown>[]): OwnerStarLookup {
  const stars = rows.map((r) => ({ ownerId: asIdentifierString(r['$ownerId']), repoId: asIdentifierString(r['repoId']) }))
  return { stars: stars.filter((s) => s.ownerId !== '' && s.repoId !== ''), complete: rows.length < OWNER_STAR_LOOKUP_LIMIT && stars.every((s) => s.ownerId !== '' && s.repoId !== '') }
}

/**
 * The repos of `pairs` whose owner stars them now (`star.byOwner`, `$ownerId` then the terminal
 * `repoId`: one entry or none, v5 `book/src/drive/index-only-document-types.md:455-457`).
 *
 * With `lookup` (the batched read of the owners' stars) nothing is requested here: a pair it
 * shows is starred, and when it is `complete` any other is not. A pair it cannot settle (no
 * lookup: the composite was refused; or it ran out of rows before the owner's stars ended) is
 * read on its own, a few at a time, and one whose read fails is left out, so its star counts as
 * it was read.
 */
export async function readOwnerStars(
  sdk: EvoSDK,
  forge: ForgeIds,
  pairs: readonly { readonly repoId: string; readonly ownerId: string }[],
  lookup: OwnerStarLookup | null = null,
): Promise<Set<string>> {
  const starred = new Set<string>()
  const seen = new Set((lookup?.stars ?? []).map((s) => `${s.ownerId}/${s.repoId}`))
  const unsettled = pairs.filter(({ repoId, ownerId }) => {
    if (seen.has(`${ownerId}/${repoId}`)) {
      starred.add(repoId)
      return false
    }
    return lookup === null || !lookup.complete
  })
  for (let i = 0; i < unsettled.length; i += OWNER_STAR_PARALLEL) {
    await Promise.all(
      unsettled.slice(i, i + OWNER_STAR_PARALLEL).map(({ repoId, ownerId }) =>
        hasStar(sdk, forge, ownerId, repoId).then(
          (yes) => void (yes && starred.add(repoId)),
          // eslint-disable-next-line no-console
          (e: unknown) => console.warn(`Trending: could not tell whether ${repoId}'s owner stars it; counted as read`, e),
        ),
      ),
    )
  }
  return starred
}

/** The window a Trending read of `span` selects at `nowMs` (`star.byWeek` and `starBeat.byWeek` share the grid). */
export function trendingWindowOf(span: TrendingWindow, nowMs: number): Window | null {
  return trendingWindow(STAR_BEAT_GRID, nowMs, span === 'week' ? 'oldest' : 'newest')
}

/**
 * A fused-star Trending page (RC2 C1) with RC1's beat rules (O-08) applied on read, since
 * consensus no longer applies them: a private repo is dropped, and the owner's own star is
 * taken out of its repo's count. Rows left with no stargazer are dropped, the rest re-ranked
 * as Drive ranks (count descending, then group key descending), at most `limit`.
 *
 * The owner's star can only be taken out where it is known to be in the window: no index gives
 * a star's time back (`byWeek` holds bucket starts and serves counts only, rs-drive
 * `query/index_only_synthesis.rs:893-911`; `byOwner` holds no time). A repo created inside the
 * window whose owner stars it now was starred inside it, so `ownerStarred` holds those repos
 * (see {@link selfStarDecidable}). Two cases stay approximate, by at most one stargazer per
 * repo: an owner's star of an older repo made inside the window is counted, and an owner who
 * starred and unstarred inside the window still counts there (`outlivesDelete`).
 *
 * The page is read {@link FUSED_READ_AHEAD} times deeper than it shows, so the tail is
 * approximate too: a repo just past the read whose count ties or tops a decremented row is not
 * seen, and a page whose read is mostly private repos shows fewer rows than `limit`.
 */
export function fusedTrending<R extends TrendingRepo>(
  entries: readonly RankedEntry[],
  repos: ReadonlyMap<string, R>,
  ownerStarred: ReadonlySet<string>,
  limit: number,
): (R & { readonly rankCount: number })[] {
  const rows = entries.flatMap((e) => {
    const repo = repos.get(e.group)
    if (repo === undefined || repo.visibility !== 'public') return []
    const count = e.count - (ownerStarred.has(e.group) ? 1 : 0)
    return count > 0 ? [{ repo, count, key: e.keyHex }] : []
  })
  rows.sort((a, b) => b.count - a.count || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
  return rows.slice(0, limit).map(({ repo, count }) => ({ ...repo, rankCount: count }))
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
