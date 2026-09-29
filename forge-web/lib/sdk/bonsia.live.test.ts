/**
 * Live, read-only: forge-web's own connection (trusted quorum keys, the DAPI fetch gate) reads
 * devnet bonsia. Nothing is written. (The beta.7 wasm SDK sends `https://node:1443//org.dash…`;
 * bonsia's gateway merges the slashes since 2026-09-29: dash-forge-qa/upstream/dapi-double-slash.md.)
 *
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=bonsia pnpm vitest run lib/sdk/bonsia.live.test.ts
 */

import { describe, expect, it } from 'vitest'

import { NETWORKS } from '../constants'
import { ensureSdk } from './service'

const live = process.env['FORGE_LIVE'] === '1' && NETWORKS.devnet.devnetName === 'bonsia'

describe.skipIf(!live)('devnet bonsia (live, read-only)', () => {
  it('connects and reads the status and the DPNS contract', async () => {
    const sdk = await ensureSdk('devnet')
    const status = (await sdk.system.status()) as unknown as { toJSON(): { network: { chainId: string }; version: { software: { drive: string } } } }
    expect(status.toJSON().network.chainId).toBe('dash-devnet-bonsia-g1')
    expect(status.toJSON().version.software.drive).toMatch(/^4\.2\./)
    const dpns = await sdk.contracts.fetch(NETWORKS.devnet.dpnsContractId)
    expect(dpns).toBeTruthy()
  }, 120_000)
})
