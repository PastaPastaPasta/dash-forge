/**
 * The bundled contract snapshots (`forge-contracts/deployments/contracts/<key>.json`) must hold
 * exactly the contracts the web build reads, as the deployment file names them, in bytes the
 * pinned SDK decodes. Re-run `forge-contracts/scripts/snapshot-contracts.mjs` when this fails.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { DEPLOYMENTS, forgeV2Ids, type DeploymentFile } from '../deployments'
import { SNAPSHOT_KEYS, loadContractSnapshots } from './contract-seed'
import { snapshotIds } from '../../../forge-contracts/scripts/snapshot-contracts.mjs'

const SNAPSHOT_DIR = resolve(process.cwd(), '..', 'forge-contracts', 'deployments', 'contracts')
const CONTRACTS_DIR = resolve(process.cwd(), '..', 'forge-contracts', 'contracts')

/**
 * The forge-core schema the deployment registered: the committed set its record names
 * (`contracts/mainnet/` for a four-contract production registration, whose forge-core lacks the
 * types that moved to forge-meta), else the top-level three-contract file.
 */
function forgeCoreSchema(deployment: DeploymentFile | undefined): { documentSchemas?: Record<string, unknown> } {
  const set = deployment?.v2?.contractsSet ?? (deployment?.v2?.forgeMeta ? 'mainnet' : null)
  const file = set === null ? 'forge-core.json' : `${set}/forge-core.json`
  return JSON.parse(readFileSync(resolve(CONTRACTS_DIR, file), 'utf8')) as { documentSchemas?: Record<string, unknown> }
}

type Evo = typeof import('@dashevo/evo-sdk')
let evo: Evo

beforeAll(async () => {
  evo = await import('@dashevo/evo-sdk')
  await evo.EvoSDK.getLatestVersionNumber()
})

describe('contract snapshots', () => {
  it('wires every snapshot file into contract-seed.ts', () => {
    const files = readdirSync(SNAPSHOT_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort()
    expect([...SNAPSHOT_KEYS].sort()).toEqual(files)
  })

  // CONT-13 / WEB-09: a live deployment with no bundled snapshot makes every first page load fetch
  // its contracts. This fails the testnet registration PR until its snapshot is committed and wired.
  it('has a snapshot for every deployment that is live', () => {
    for (const [key, file] of Object.entries(DEPLOYMENTS)) {
      if (forgeV2Ids(file) && !file.retired) {
        expect(SNAPSHOT_KEYS, `${key} is live but has no contract snapshot: run forge-contracts/scripts/snapshot-contracts.mjs`).toContain(key)
      }
    }
  })

  for (const key of SNAPSHOT_KEYS) {
    it(`${key}: holds the deployment's contracts, decodable at their recorded version`, async () => {
      const deployment = DEPLOYMENTS[key]
      expect(deployment).toBeDefined()
      const snapshots = await loadContractSnapshots(key)
      expect(Object.keys(snapshots).sort()).toEqual([...(snapshotIds(deployment) as string[])].sort())
      for (const [id, snapshot] of Object.entries(snapshots)) {
        const contract = evo.DataContract.fromBase64(snapshot.bytes, false, snapshot.platformVersion)
        expect(contract.id.toBase58()).toBe(id)
        expect(contract.version).toBe(snapshot.version)
        // The forge-core snapshot is the schema of the set the deployment registered.
        if (id === deployment?.v2?.forgeCore?.contractId) {
          expect(Object.keys(contract.schemas).sort()).toEqual(Object.keys(forgeCoreSchema(deployment).documentSchemas ?? {}).sort())
        }
      }
    })
  }
})
