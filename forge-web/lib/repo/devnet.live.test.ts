/**
 * Live devnet smoke — SKIPPED by default (needs network + WASM).
 *
 * Run with:
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=moutai \
 *     pnpm exec vitest run lib/repo/devnet.live.test.ts
 *
 * Proves the devnet connect path of `evoSdkService` works as the app builds it: a trusted
 * connect that fetches quorum keys from the devnet's quorum service and uses the deployment
 * file's DAPI addresses, then proof-verified fetches of both forge-v2 contracts. It also pins
 * the protocol version the SDK learned from those proved reads (protocol 14 on a devnet cut
 * from the current development line). Never gates CI.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { evoSdkService } from '../sdk'

const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet'

interface ContractsFetch {
  contracts: { fetch(id: string): Promise<{ id: { toString(): string } } | undefined> }
}

describe.skipIf(!LIVE)('live devnet connect', () => {
  it(
    'connects trusted and proof-fetches both forge-v2 contracts',
    async () => {
      const v2 = NETWORKS.devnet.v2
      expect(v2, 'the devnet deployment must record forge-v2 ids').not.toBeNull()
      const ids = v2 as NonNullable<typeof v2>

      await evoSdkService.initialize({
        network: 'devnet',
        contractIds: [ids.core, ids.collab],
        timeoutMs: 20000,
      })
      expect(evoSdkService.isTrusted).toBe(true)
      const sdk = evoSdkService.getSdk()

      const contracts = (sdk as unknown as ContractsFetch).contracts
      const core = await contracts.fetch(ids.core)
      const collab = await contracts.fetch(ids.collab)
      expect(core?.id.toString()).toBe(ids.core)
      expect(collab?.id.toString()).toBe(ids.collab)
      expect(sdk.version()).toBeGreaterThanOrEqual(14)
    },
    90000,
  )
})
