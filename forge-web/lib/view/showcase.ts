/**
 * Showcase repos (QW-045): the repos the landing page features on a network, so a first visit
 * sees real projects rather than whatever test repos were created last. Listed by owner and
 * name per network key; each is read (and proof-checked) like any other repo, and one that does
 * not resolve is left out. A network with none configured features nothing.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { resolveAnyRepo } from '../repo'
import { fromRepoDoc, type DiscoveredRepo } from './discovery'

export interface ShowcaseEntry {
  readonly owner: string
  readonly name: string
}

/** By network key (`ACTIVE_NETWORK.key`). */
export const SHOWCASE: Readonly<Record<string, readonly ShowcaseEntry[]>> = {
  'devnet-bonsia': [
    // Mirrors of dashpay/dips and dashpay/dash, and the seeded demo repo.
    { owner: '3gvojK6k3Kt3QjeerN5JE8tbvFhUaTChwhZMbYKjizzs', name: 'dips' },
    { owner: '7A1MEuLjzcHZq8bLBzGYSUkpb2VM9dv7gtNuNYrPxKt3', name: 'dash' },
    { owner: '2X2XM6kF5DK9Vx8Mfot4wetvppBKLE1W3tC87NA36jXP', name: 'forge-v2-demo' },
  ],
}

/** The showcase entries of a network key. */
export function showcaseFor(networkKey: string): readonly ShowcaseEntry[] {
  return SHOWCASE[networkKey] ?? []
}

/** The showcase repos that resolve, in the configured order. */
export async function listShowcaseRepos(sdk: EvoSDK, network: Network, networkKey: string): Promise<DiscoveredRepo[]> {
  const found = await Promise.all(
    showcaseFor(networkKey).map((e) =>
      resolveAnyRepo(sdk, { network, owner: e.owner, name: e.name }).catch(() => null),
    ),
  )
  return found.flatMap((r) => (r === null || r.doc.visibility !== 'public' ? [] : [fromRepoDoc(r.doc)]))
}
