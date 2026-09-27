/**
 * The copy-paste commands a repository page shows (clone box, empty-repository state). Each
 * one names this build's network, so it works pasted verbatim on a machine where nothing
 * else chose one: `git-remote-dash` otherwise takes `DASH_FORGE_NETWORK`, then git config
 * `dash.network`, then the network `dg auth` saved, then testnet (L-03). The network rides in
 * git config (`git clone -c …` persists it into the clone; `git config` in an existing
 * repository), never in the `dash://` URL, which names only the repository.
 */

import { ACTIVE_NETWORK, type NetworkConfig } from '@/lib/constants'

/** The `git config` keys and values that select `config`'s network for git-remote-dash. */
export function gitNetworkConfig(config: NetworkConfig = ACTIVE_NETWORK): readonly (readonly [string, string])[] {
  return config.devnetName !== null
    ? [
        ['dash.network', 'devnet'],
        ['dash.devnetName', config.devnetName],
      ]
    : [['dash.network', config.network]]
}

/** The `dg` flags that select `config`'s network. */
export function dgNetworkFlags(config: NetworkConfig = ACTIVE_NETWORK): string {
  return config.devnetName !== null ? `--network devnet --devnet-name ${config.devnetName}` : `--network ${config.network}`
}

export interface RepoCommands {
  /** `dash://owner/name`: the remote URL. */
  readonly remote: string
  /** `git clone -c dash.network=… dash://owner/name`: the network is kept in the clone's config. */
  readonly gitClone: string
  /** `dg repo clone owner/name --network …`: clones, and records the network in the clone. */
  readonly dgClone: string
  /** `git remote add origin dash://…`, for an existing repository. */
  readonly remoteAdd: string
  /** `git config dash.network … && …`: this repository's network, before its first push. */
  readonly setNetwork: string
}

/** The commands for `owner/name` on `config`'s network. */
export function repoCommands(owner: string, name: string, config: NetworkConfig = ACTIVE_NETWORK): RepoCommands {
  const remote = `dash://${owner}/${name}`
  const pairs = gitNetworkConfig(config)
  return {
    remote,
    gitClone: `git clone ${pairs.map(([k, v]) => `-c ${k}=${v} `).join('')}${remote}`,
    dgClone: `dg repo clone ${owner}/${name} ${dgNetworkFlags(config)}`,
    remoteAdd: `git remote add origin ${remote}`,
    setNetwork: pairs.map(([k, v]) => `git config ${k} ${v}`).join(' && '),
  }
}
