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

/** One contract's record: `status` is `registered` once confirmed (v2 records only). */
export interface ContractRecord {
  readonly contractId?: string | null
  readonly ownerId?: string | null
  readonly status?: string
}

/** The fields forge-web reads from a deployment file. */
export interface DeploymentFile {
  readonly dapiAddresses?: readonly string[]
  readonly quorumBaseUrl?: string | null
  readonly registry?: ContractRecord | null
  /** The forge-v2 record `forge-contracts/scripts/deploy-v2.mjs` read-modify-writes. */
  readonly v2?: {
    readonly forgeCore?: ContractRecord
    readonly forgeCollab?: ContractRecord
    readonly contractGroupId?: string
  }
}

/** The forge-v2 contracts registered on a network (base58 ids). */
export interface ForgeIds {
  /** forge-core (repos, refs, packs). */
  readonly core: string
  /** forge-collab (issues, PRs, reviews, social graph). */
  readonly collab: string
  /** The contract group both belong to. */
  readonly group: string
}

function registeredId(record: ContractRecord | undefined): string | null {
  if (record?.status !== 'registered') return null
  return record.contractId || null
}

/**
 * A file's forge-v2 ids, or null unless both contracts are registered and the group is
 * recorded — a half-finished deploy is not a usable deployment (parity with forge-core
 * `network::V2Record::ids`).
 */
export function forgeV2Ids(file: DeploymentFile | undefined): ForgeIds | null {
  const core = registeredId(file?.v2?.forgeCore)
  const collab = registeredId(file?.v2?.forgeCollab)
  const group = file?.v2?.contractGroupId || null
  return core && collab && group ? { core, collab, group } : null
}

/** Deployment key (`testnet`, `mainnet`, `devnet-<name>`) → file contents. */
export const DEPLOYMENTS: Readonly<Record<string, DeploymentFile>> = {
  testnet,
  'devnet-moutai': devnetMoutai,
}
