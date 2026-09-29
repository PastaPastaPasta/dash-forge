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
import mainnet from '../../forge-contracts/deployments/mainnet.json'
import testnet from '../../forge-contracts/deployments/testnet.json'

/** One contract's record: `status` is `registered` once confirmed. */
export interface ContractRecord {
  readonly contractId?: string | null
  readonly ownerId?: string | null
  readonly status?: string
}

/** A superseded contract's record: which group it was left in. */
export interface SupersededRecord {
  readonly contractId?: string | null
  readonly contractGroupId?: string | null
}

/** The fields forge-web reads from a deployment file. */
export interface DeploymentFile {
  readonly dapiAddresses?: readonly string[]
  readonly quorumBaseUrl?: string | null
  /**
   * The legacy wallet key-exchange contract (`loginKeyResponse`) the shipped Dash wallets publish
   * to: yappr's on testnet, a copy on a devnet (`forge-contracts/scripts/deploy-key-exchange.mjs`).
   */
  readonly keyExchange?: { readonly contractId?: string | null }
  /** The forge-v2 record `forge-contracts/scripts/deploy-v2.mjs` read-modify-writes. */
  readonly v2?: {
    readonly forgeCore?: ContractRecord
    readonly forgeCollab?: ContractRecord
    /** Absent on a deployment that predates the three-contract split. */
    readonly forgeCommunity?: ContractRecord
    readonly contractGroupId?: string
    /** The group `deploy-v2.mjs` verified on chain: its id and owner (the deployer). */
    readonly contractGroup?: { readonly id?: string; readonly owner?: string }
    /** Earlier contracts `deploy-v2.mjs` superseded, some left in the current group. */
    readonly forgeCoreSuperseded?: readonly SupersededRecord[]
    readonly forgeCollabSuperseded?: readonly SupersededRecord[]
    readonly forgeCommunitySuperseded?: readonly SupersededRecord[]
    /** The devnet `deploy-v2.mjs` registered on, with the DAPI addresses it used. */
    readonly devnet?: { readonly addresses?: readonly string[] }
  }
}

/**
 * A file's recorded DAPI addresses: top-level `dapiAddresses`, else the ones `deploy-v2.mjs`
 * recorded under `v2.devnet.addresses` (parity with forge-core `network::deployment`).
 */
export function recordedDapiAddresses(file: DeploymentFile | undefined): readonly string[] {
  return file?.dapiAddresses ?? file?.v2?.devnet?.addresses ?? []
}

/** The forge-v2 contracts registered on a network (base58 ids). */
export interface ForgeIds {
  /** forge-core (repos, refs, packs). */
  readonly core: string
  /** forge-collab (issues, PRs, transitions, reviews, events, milestones). */
  readonly collab: string
  /**
   * forge-community (profiles, stars, watches, follows, check runs, policies, webhooks);
   * forge-collab's id on a deployment that predates the three-contract split.
   */
  readonly community: string
  /** The contract group they all belong to. */
  readonly group: string
}

/** One of Forge's contracts, by role. */
export type ForgeContractKind = 'core' | 'collab' | 'community'
export const FORGE_CONTRACT_KINDS: readonly ForgeContractKind[] = ['core', 'collab', 'community']

/**
 * Which of Forge's contracts `contractId` is, or null for any other. On a deployment that
 * predates the split forge-community is forge-collab, and the id reads as `collab`.
 */
export function contractKind(forge: ForgeIds, contractId: string | undefined): ForgeContractKind | null {
  return FORGE_CONTRACT_KINDS.find((k) => forge[k] === contractId) ?? null
}

function registeredId(record: ContractRecord | undefined): string | null {
  if (record?.status !== 'registered') return null
  return record.contractId || null
}

/**
 * A file's forge-v2 ids, or null unless every contract is registered and the group is
 * recorded — a half-finished deploy is not a usable deployment (parity with forge-core
 * `network::V2Record::ids`). A file with no forge-community record predates the split: its
 * community types are in forge-collab.
 */
export function forgeV2Ids(file: DeploymentFile | undefined): ForgeIds | null {
  const core = registeredId(file?.v2?.forgeCore)
  const collab = registeredId(file?.v2?.forgeCollab)
  const recorded = file?.v2?.forgeCommunity
  const community = recorded == null ? collab : registeredId(recorded)
  const group = file?.v2?.contractGroupId || null
  return core && collab && community && group ? { core, collab, community, group } : null
}

/**
 * What binding a key to the forge contract group trusts, as the bundled deployment file pins it
 * (`docs/contracts/forge-v2.md` § Contract group trust; parity with forge-core `ForgeIds`).
 */
export interface GroupTrust {
  readonly group: string
  readonly core: string
  readonly collab: string
  readonly community: string
  /** The group's owner, the Forge deployer: null when the file records none. The group must also have no admins. */
  readonly owner: string | null
  /** Forge's own earlier contracts left in the same group. */
  readonly superseded: readonly string[]
}

/**
 * A file's group trust root, or null when it has no forge-v2 deployment. The owner is the
 * verified `contractGroup` record for this group, else forge-core's owner (its create
 * transition registered the group).
 */
export function groupTrust(file: DeploymentFile | undefined): GroupTrust | null {
  const ids = forgeV2Ids(file)
  const v2 = file?.v2
  if (!ids || !v2) return null
  const recorded = v2.contractGroup?.id === ids.group ? v2.contractGroup : undefined
  const owner = recorded?.owner || v2.forgeCore?.ownerId || null
  const superseded = [...(v2.forgeCoreSuperseded ?? []), ...(v2.forgeCollabSuperseded ?? []), ...(v2.forgeCommunitySuperseded ?? [])]
    .filter((r) => r.contractGroupId === ids.group && r.contractId)
    .map((r) => r.contractId as string)
  return { ...ids, owner, superseded }
}

/**
 * Deployment key (`testnet`, `mainnet`, `devnet-<name>`) → file contents. A network with no
 * file here has no forge-v2 deployment and shows "not deployed".
 */
export const DEPLOYMENTS: Readonly<Record<string, DeploymentFile>> = {
  testnet,
  mainnet,
  'devnet-moutai': devnetMoutai,
}
