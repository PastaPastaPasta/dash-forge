/**
 * The networks Forge has a deployment record for, and where each stands, for the Networks page
 * (`/networks`). Read from the bundled `forge-contracts/deployments/*.json`, the same files that
 * pick the contracts, so the page cannot drift from what the app and `dg` actually use.
 */

import { DEPLOYMENTS, forgeV2Ids, type DeploymentFile } from './deployments'

export type NetworkStanding = 'live' | 'not-yet' | 'retired'

export interface NetworkRow {
  /** Deployment key: `devnet-sakura`, `testnet`, `mainnet`. */
  readonly key: string
  /** `Devnet sakura`, `Testnet`, `Mainnet`. */
  readonly label: string
  readonly standing: NetworkStanding
  /** A test network: its DASH has no value and it may be reset. */
  readonly test: boolean
}

function labelOf(key: string): string {
  if (key.startsWith('devnet-')) return `Devnet ${key.slice('devnet-'.length)}`
  return key.charAt(0).toUpperCase() + key.slice(1)
}

function standingOf(file: DeploymentFile): NetworkStanding {
  if (file.retired === true) return 'retired'
  return forgeV2Ids(file) === null ? 'not-yet' : 'live'
}

const ORDER: Readonly<Record<NetworkStanding, number>> = { live: 0, 'not-yet': 1, retired: 2 }
/** Within a standing: devnets, then testnet, then mainnet. */
const KIND = (key: string): number => (key === 'mainnet' ? 2 : key === 'testnet' ? 1 : 0)

/** Every recorded network: live ones first, then those Forge is not on yet, then retired devnets. */
export function networkRows(deployments: Readonly<Record<string, DeploymentFile>> = DEPLOYMENTS): NetworkRow[] {
  return Object.entries(deployments)
    .map(([key, file]) => ({ key, label: labelOf(key), standing: standingOf(file), test: key !== 'mainnet' }))
    .sort((a, b) => ORDER[a.standing] - ORDER[b.standing] || KIND(a.key) - KIND(b.key) || a.key.localeCompare(b.key))
}
