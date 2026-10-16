/**
 * Where a build's network gets test DASH (OD-12). Nothing is sponsored: these are other people's
 * faucets, linked and never proxied.
 *
 * - devnet: the devnet's own faucet (`faucet.<name>.networks.dash.org`);
 * - testnet: the Dash Core Group faucet first, then `faucet.thepasta.org` as the second source;
 * - mainnet: none (real DASH).
 */

import { ACTIVE_NETWORK, type NetworkConfig } from './constants'

export const TESTNET_FAUCETS: readonly string[] = ['https://faucet.testnet.networks.dash.org', 'https://faucet.thepasta.org']

/** Every faucet link for `config`, best first; empty on mainnet. */
export function faucetUrls(config: Pick<NetworkConfig, 'network' | 'devnetName'> = ACTIVE_NETWORK): readonly string[] {
  if (config.network === 'devnet') return config.devnetName === null ? [] : [`https://faucet.${config.devnetName}.networks.dash.org`]
  if (config.network === 'testnet') return TESTNET_FAUCETS
  return []
}

/** What a link reads as: the host (`faucet.thepasta.org`). */
export function faucetHost(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}
