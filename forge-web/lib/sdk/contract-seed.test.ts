/**
 * The bundled contract snapshots (`forge-contracts/deployments/contracts/<key>.json`) must hold
 * exactly the contracts the web build reads, as the deployment file names them, in bytes the
 * pinned SDK decodes. Re-run `forge-contracts/scripts/snapshot-contracts.mjs` when this fails.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { DPNS_CONTRACT_ID } from '../constants'
import { DEPLOYMENTS } from '../deployments'
import { SNAPSHOT_KEYS, loadContractSnapshots } from './contract-seed'

const SNAPSHOT_DIR = resolve(process.cwd(), '..', 'forge-contracts', 'deployments', 'contracts')

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

  for (const key of SNAPSHOT_KEYS) {
    it(`${key}: holds the deployment's contracts, decodable at their recorded version`, async () => {
      const deployment = DEPLOYMENTS[key]
      expect(deployment).toBeDefined()
      const snapshots = await loadContractSnapshots(key)
      const expected = [
        DPNS_CONTRACT_ID,
        deployment?.v2?.forgeCore?.contractId,
        deployment?.v2?.forgeCollab?.contractId,
        deployment?.keyExchange?.contractId,
      ].filter((id): id is string => typeof id === 'string' && id.length > 0)
      expect(Object.keys(snapshots).sort()).toEqual([...new Set(expected)].sort())
      for (const [id, snapshot] of Object.entries(snapshots)) {
        const contract = evo.DataContract.fromBase64(snapshot.bytes, false, snapshot.platformVersion)
        expect(contract.id.toBase58()).toBe(id)
        expect(contract.version).toBe(snapshot.version)
      }
    })
  }

  it('the forge-core snapshot is the schema in forge-contracts/contracts', async () => {
    const key = 'devnet-moutai'
    const coreId = DEPLOYMENTS[key]?.v2?.forgeCore?.contractId
    if (!coreId) return
    const snapshot = (await loadContractSnapshots(key))[coreId]
    expect(snapshot).toBeDefined()
    const contract = evo.DataContract.fromBase64(snapshot?.bytes ?? '', false, snapshot?.platformVersion ?? 14)
    const source = JSON.parse(readFileSync(resolve(process.cwd(), '..', 'forge-contracts', 'contracts', 'forge-core.json'), 'utf8')) as {
      documentSchemas?: Record<string, unknown>
    }
    const types = Object.keys(source.documentSchemas ?? {}).sort()
    expect(Object.keys(contract.schemas).sort()).toEqual(types)
  })
})
