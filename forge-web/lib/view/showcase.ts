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
 * By network key (`ACTIVE_NETWORK.key`). bonsia's entries (the dips and dash mirrors and the
 * seeded demo repo) went with that devnet; devnet-sakura's are added once they exist there.
 */
export const SHOWCASE: Readonly<Record<string, readonly ShowcaseEntry[]>> = {}

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
