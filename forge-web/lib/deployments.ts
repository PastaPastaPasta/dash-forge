/**
 * The committed `forge-contracts/deployments/<key>.json` files, bundled at build time.
 *
 * Same source forge-core embeds (its `build.rs` globs the directory). Here each file is a
 * static import so the bundler inlines it; `deployments.test.ts` fails if a file in the
 * directory is missing from this map, so committing `mainnet.json` (or a new
 * `devnet-<name>.json`) without wiring it here breaks CI instead of silently shipping a web
 * build that says "not deployed".
 */

import devnetMoutai from '../../forge-contracts/deployments/devnet-moutai.json'
import testnet from '../../forge-contracts/deployments/testnet.json'

/** The fields forge-web reads from a deployment file. */
export interface DeploymentFile {
  readonly dapiAddresses?: readonly string[]
  readonly quorumBaseUrl?: string | null
  readonly registry?: {
    readonly contractId?: string | null
    readonly ownerId?: string | null
  } | null
}

/** Deployment key (`testnet`, `mainnet`, `devnet-<name>`) → file contents. */
export const DEPLOYMENTS: Readonly<Record<string, DeploymentFile>> = {
  testnet,
  'devnet-moutai': devnetMoutai,
}
