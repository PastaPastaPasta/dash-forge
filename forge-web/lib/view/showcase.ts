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
import { discoverReposById, type DiscoveredRepo } from './discovery'

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
    // The seeded demo: code, issues and pull requests (forge-contracts/scripts/seed-v2-fixture.mjs).
    { owner: 'Amc7FjA3CJLae4stwztokTumqCX8KfDCkA3zNwVVYRZB', name: 'forge-v2-demo', repoId: 'J7cPnrdgQ2kHwXUeK4VcK5PsYmG4fntfKpFDCHSZxgo1' },
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
