/**
 * Live testnet smoke test — SKIPPED by default (needs network + WASM).
 *
 * Run with:  FORGE_LIVE=1 pnpm exec vitest run lib/repo/live.test.ts
 *
 * Proves the read stack talks to the deployed registry: connect via testnetTrusted(),
 * query the registry `repoListing` type with a proof, and — if any listing exists —
 * resolve its repo contract owner. A bonus check; never gates CI (WASM/network flaky).
 */

import { describe, expect, it } from 'vitest'

import { NETWORKS } from '../constants'
import { evoSdkService } from '../sdk'
import { queryDocumentsWithProof } from '../sdk'
import { REGISTRY_DOC } from './contract'
import { resolveRepoByContractId } from './resolveRepo'

const LIVE = process.env['FORGE_LIVE'] === '1'

describe.skipIf(!LIVE)('live testnet reads', () => {
  it(
    'connects and queries the deployed registry',
    async () => {
      const registryId = NETWORKS.testnet.registryContractId
      expect(registryId).not.toBeNull()

      await evoSdkService.initialize({
        network: 'testnet',
        contractIds: registryId ? [registryId] : [],
        timeoutMs: 15000,
      })
      const sdk = evoSdkService.getSdk()

      const { documents } = await queryDocumentsWithProof(sdk, {
        dataContractId: registryId as string,
        documentTypeName: REGISTRY_DOC.repoListing,
        orderBy: [['$createdAt', 'desc']],
        limit: 5,
      })
      // Zero listings is a valid result on a fresh registry; the point is a proof-verified
      // round-trip that did not throw.
      expect(Array.isArray(documents)).toBe(true)

      const first = documents[0]
      if (first && typeof first['repoContractId'] === 'string') {
        const repo = await resolveRepoByContractId(sdk, first['repoContractId'])
        expect(repo === null || typeof repo.ownerId === 'string').toBe(true)
      }
    },
    30000,
  )
})
