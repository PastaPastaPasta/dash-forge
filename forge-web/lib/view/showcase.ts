/**
 * Showcase repos (QW-045): the repos the landing page and Explore feature on a network, so a first
 * visit sees real projects rather than whatever test repos were created or starred last. Listed
 * per network key by owner, name and repo id: all of them are read in one composite by id (with
 * their star and issue counts and the owners' names, as Explore's ranked cards are), and a repo
 * is shown only when its owner and name are the entry's (so another repo of the same name, like a
 * second "forge-v2-demo", never stands in). One that does not resolve is left out. A network
 * with none configured features nothing.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { discoverReposById, recentReposPage, REPO_PAGE, type DiscoveredRepo } from './discovery'

export interface ShowcaseEntry {
  readonly owner: string
  readonly name: string
  /** The `repo` document id: the one repo this entry means. */
  readonly repoId: string
}

/**
 * By network key (`ACTIVE_NETWORK.key`). A network that gets a Forge deployment gets its entries
 * here as part of its pre-flight checklist (docs/mainnet-runbook.md), or its landing page features
 * nothing.
 */
export const SHOWCASE: Readonly<Record<string, readonly ShowcaseEntry[]>> = {
  'devnet-sakura': [
    // The mirrors of github.com/dashpay/dash and github.com/dashpay/dips go first once they are
    // re-imported: sakura's Platform reset to 5.0.0-beta.2 (2026-10-06) took the old ones.
    // The seeded demo: code, issues and pull requests (forge-contracts/scripts/seed-v2-fixture.mjs),
    // re-seeded after sakura's third Platform reset, onto 5.0.0-beta.6 (2026-10-13).
    { owner: 'Amc7FjA3CJLae4stwztokTumqCX8KfDCkA3zNwVVYRZB', name: 'forge-v2-demo', repoId: 'Hynz8VtPiEBXn7VcMLCLCPgNo4uVK2KKveGn5P4CvinW' },
  ],
}

/** The showcase entries of a network key. */
export function showcaseFor(networkKey: string): readonly ShowcaseEntry[] {
  return SHOWCASE[networkKey] ?? []
}

/** The showcase repos that resolve, in the configured order (one request). */
export async function listShowcaseRepos(
  sdk: EvoSDK,
  network: Network,
  networkKey: string,
  entries: readonly ShowcaseEntry[] = showcaseFor(networkKey),
): Promise<DiscoveredRepo[]> {
  if (entries.length === 0) return []
  const byId = await discoverReposById(sdk, entries.map((e) => e.repoId), { network })
  return entries.flatMap((e) => {
    const r = byId.get(e.repoId)
    return r === undefined || r.ownerId !== e.owner || r.slug !== e.name || r.visibility !== 'public' ? [] : [r]
  })
}

/**
 * The landing page's recent feed without the test debris (CJ-1): only repos with a description
 * and a push the page's push lookup saw (one in the last week, which every repo created in that
 * week and ever pushed has). When the lookup was cut short or refused (`pushesKnown` false), a
 * missing push proves nothing, so only the description counts. The rest stay one click away
 * ("Show all recent repos").
 */
export function isCurated(repo: DiscoveredRepo, pushesKnown = true): boolean {
  return repo.description.trim() !== '' && (repo.pushedAt != null || !pushesKnown)
}

/** Most repos of one owner the landing page's recent feed shows (ABU-V-03). */
export const RECENT_PER_OWNER = 2

/**
 * `repos` (newest first) with at most `max` per owner, the newest of each kept. One identity
 * creating repos in bulk must not own the front page; the full list is on Explore.
 */
export function capPerOwner<T extends { readonly ownerId: string }>(repos: readonly T[], max = RECENT_PER_OWNER): T[] {
  const seen = new Map<string, number>()
  return repos.filter((r) => {
    const n = (seen.get(r.ownerId) ?? 0) + 1
    seen.set(r.ownerId, n)
    return n <= max
  })
}

/**
 * The landing page's recent feed: `repos` without `exclude` (the featured ones, shown above it),
 * then, unless `showAll`, only the curated ones ({@link isCurated}), then at most
 * {@link RECENT_PER_OWNER} per owner. The cap comes last, so an owner's undescribed repos do not
 * take the slots of their described ones. `notCurated`: how many "Show all" would add back (the
 * per-owner cap is not counted: it holds there too); `capped`: how many the cap left out.
 */
export function landingRecent<T extends DiscoveredRepo>(
  repos: readonly T[],
  opts: { exclude?: ReadonlySet<string>; pushesKnown: boolean; showAll: boolean },
): { shown: T[]; notCurated: number; capped: number } {
  const base = repos.filter((r) => !(opts.exclude?.has(r.key) ?? false))
  const list = opts.showAll ? base : base.filter((r) => isCurated(r, opts.pushesKnown))
  const shown = capPerOwner(list)
  return { shown, notCurated: base.length - list.length, capped: list.length - shown.length }
}

/** Repos the landing feed tries to show before it stops reading older pages. */
const LANDING_TARGET = 12
/** Most pages the landing feed reads to reach {@link LANDING_TARGET}. */
const LANDING_PAGES = 3

/**
 * The newest public repos for the landing page, read on while one owner's (or the hidden ones')
 * flood leaves the visible feed short, at most {@link LANDING_PAGES} pages. One page, when it
 * already fills the feed. Hidden repos are already gone (`recentReposPage`).
 */
export async function recentFeed(
  sdk: EvoSDK,
  opts: { network: Network; limit?: number },
): Promise<{ repos: DiscoveredRepo[]; pushesComplete: boolean; fallback: boolean; more: boolean }> {
  const repos: DiscoveredRepo[] = []
  let pushesComplete = true
  let fallback = false
  let after = null as Awaited<ReturnType<typeof recentReposPage>>['next']
  for (let i = 0; i < LANDING_PAGES; i++) {
    const page = await recentReposPage(sdk, { network: opts.network, limit: opts.limit ?? REPO_PAGE, after })
    repos.push(...page.repos)
    pushesComplete &&= page.pushesComplete
    fallback ||= page.fallback
    after = page.next
    if (page.next === null || landingRecent(repos, { pushesKnown: pushesComplete && !fallback, showAll: false }).shown.length >= LANDING_TARGET) break
  }
  // `more`: older repos follow, so an empty result (every row read was hidden on this site) is not
  // an empty network.
  return { repos, pushesComplete, fallback, more: after !== null }
}
