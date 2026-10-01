/**
 * Contract snapshots that seed evo-sdk's contract cache, so a page needs no `getDataContract`
 * request before its first query (platform-parity-spec §3.4).
 *
 * `forge-contracts/scripts/snapshot-contracts.mjs` writes one file per deployment:
 * `forge-contracts/deployments/contracts/<key>.json`, mapping contract id to
 * `{ version, platformVersion, bytes }`. The files load lazily, next to the SDK chunk, never in
 * the first-paint bundle. `contract-seed.test.ts` fails while a snapshot and its deployment
 * file disagree.
 *
 * The cache fails closed: wasm-sdk drops a cached contract once a document carries a newer
 * `$contractVersion` and fetches the current one (`WasmSdk::drop_stale_contract`), so an
 * outdated snapshot costs one extra fetch, never a wrong read.
 */

/** One snapshot entry: the contract's own version and its Platform-serialized bytes (base64). */
export interface ContractSnapshot {
  readonly version: number
  readonly platformVersion: number
  readonly bytes: string
}

export type ContractSnapshots = Readonly<Record<string, ContractSnapshot>>

/**
 * Deployment key → snapshot loader. Add an entry when a deployment gets a snapshot.
 *
 * devnet moutai has none: its beta.6 registration's `lookup` / `propertyAgreement` bytes are
 * refused by beta.7 on every parse (platform#5197), so a moutai build fetches its contracts
 * (one request each, cached).
 *
 * devnet sakura has none until its RC2 registration on Platform v5. (bonsia's RC1 (beta.7) bytes of
 * forge-community carried checkRun's `immutableAllowSetting`, which v5 refuses on every parse:
 * rs-dpp 5.0.0-beta.1 `document_type/class_methods/try_from_schema/common/mod.rs:3106-3134`.)
 * After the registration, `snapshot-contracts.mjs` writes `devnet-sakura.json`; add its entry
 * here (`contract-seed.test.ts` fails until then).
 */
const SNAPSHOTS: Readonly<Record<string, () => Promise<{ default: ContractSnapshots }>>> = {}

/** The deployment keys that have a snapshot. */
export const SNAPSHOT_KEYS: readonly string[] = Object.keys(SNAPSHOTS)

/** The snapshot for a deployment key, or an empty map when it has none. */
export async function loadContractSnapshots(deploymentKey: string): Promise<ContractSnapshots> {
  const load = SNAPSHOTS[deploymentKey]
  return load === undefined ? {} : (await load()).default
}
