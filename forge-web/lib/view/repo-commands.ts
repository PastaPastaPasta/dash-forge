/**
 * The repository page's copy-paste commands. Each names this build's network, so it works
 * pasted verbatim where nothing else chose one (else git-remote-dash falls back to testnet:
 * L-03). The network goes into git config (`git clone -c …` keeps it in the clone), never
 * into the `dash://` URL, which names only the repository.
 */

import { ACTIVE_NETWORK, type NetworkConfig } from '@/lib/constants'

/** The `git config` keys and values that select `config`'s network for git-remote-dash. */
function gitNetworkConfig(config: NetworkConfig): [string, string][] {
  return config.devnetName !== null
    ? [
        ['dash.network', 'devnet'],
        ['dash.devnetName', config.devnetName],
      ]
    : [['dash.network', config.network]]
}

/** The `dg` flags that select `config`'s network. */
function dgNetworkFlags(config: NetworkConfig): string {
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
    gitClone: ['git clone', ...pairs.map(([k, v]) => `-c ${k}=${v}`), remote].join(' '),
    dgClone: `dg repo clone ${owner}/${name} ${dgNetworkFlags(config)}`,
    remoteAdd: `git remote add origin ${remote}`,
    setNetwork: pairs.map(([k, v]) => `git config ${k} ${v}`).join(' && '),
  }
}
