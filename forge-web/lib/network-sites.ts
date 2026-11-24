/**
 * Where each network's Forge site lives, so one network's build can point at the other's. Each
 * build reads and writes one network (`NEXT_PUBLIC_NETWORK`); the hosted mainnet and testnet
 * builds are separate sites, named per build with `NEXT_PUBLIC_MAINNET_SITE_URL` and
 * `NEXT_PUBLIC_TESTNET_SITE_URL`. A value that is not an https origin is ignored.
 */

import { ACTIVE_NETWORK, type NetworkConfig } from './constants'
import { DEPLOYMENTS, forgeV2Ids, type DeploymentFile } from './deployments'

/** The site URLs this build knows, by deployment key. */
export interface NetworkSites {
  readonly mainnet: string | null
  readonly testnet: string | null
}

/** `raw` as an https origin (`https://host`), or null. */
export function siteOrigin(raw: string | undefined): string | null {
  const s = raw?.trim() ?? ''
  if (s === '') return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.pathname !== '/' || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') return null
  return u.origin
}

// `process.env.NEXT_PUBLIC_*` must be written out literally: Next inlines each at build time.
export const NETWORK_SITES: NetworkSites = {
  mainnet: siteOrigin(process.env.NEXT_PUBLIC_MAINNET_SITE_URL),
  testnet: siteOrigin(process.env.NEXT_PUBLIC_TESTNET_SITE_URL),
}

/** The site for the network `key` (`mainnet`, `testnet`), or null when none is configured. */
export function siteUrlFor(key: string, sites: NetworkSites = NETWORK_SITES): string | null {
  return key === 'mainnet' || key === 'testnet' ? sites[key] : null
}

/** A site on another network that this build points to. */
export interface OtherSite {
  readonly key: 'mainnet' | 'testnet'
  readonly url: string
  readonly host: string
}

/**
 * The site to point to from this build: on mainnet the testnet site; on a test network the
 * mainnet site, once the bundled mainnet record has Forge's contracts. Null when there is none.
 */
export function otherNetworkSite(
  config: Pick<NetworkConfig, 'network'> = ACTIVE_NETWORK,
  sites: NetworkSites = NETWORK_SITES,
  deployments: Readonly<Record<string, DeploymentFile>> = DEPLOYMENTS,
): OtherSite | null {
  const key = config.network === 'mainnet' ? 'testnet' : 'mainnet'
  const url = siteUrlFor(key, sites)
  if (url === null) return null
  if (key === 'mainnet' && forgeV2Ids(deployments['mainnet']) === null) return null
  return { key, url, host: new URL(url).host }
}
