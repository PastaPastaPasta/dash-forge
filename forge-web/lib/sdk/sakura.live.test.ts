/**
 * Live, read-only: forge-web's own connection (trusted quorum keys, the DAPI fetch gate) reads
 * devnet sakura (Platform v5.0.0-beta.3). Nothing is written. The chain id it must report is the
 * one `forge-contracts/deployments/devnet-sakura.json` records (sakura's has no `-g1` suffix).
 *
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=sakura pnpm vitest run lib/sdk/sakura.live.test.ts
 */

import { describe, expect, it } from 'vitest'

import { NETWORKS } from '../constants'
import { DEPLOYMENTS } from '../deployments'
import { ensureSdk } from './service'

const live = process.env['FORGE_LIVE'] === '1' && NETWORKS.devnet.devnetName === 'sakura'

describe.skipIf(!live)('devnet sakura (live, read-only)', () => {
  it('connects and reads the status and the DPNS contract', async () => {
    const sdk = await ensureSdk('devnet')
    const status = (await sdk.system.status()) as unknown as { toJSON(): { network: { chainId: string }; version: { software: { drive: string } } } }
    expect(status.toJSON().network.chainId).toBe(DEPLOYMENTS['devnet-sakura']?.chainId)
    expect(status.toJSON().version.software.drive).toMatch(/^5\./)
    const dpns = await sdk.contracts.fetch(NETWORKS.devnet.dpnsContractId)
    expect(dpns).toBeTruthy()
  }, 120_000)
})
