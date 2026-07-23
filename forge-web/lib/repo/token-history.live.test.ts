/**
 * Live testnet smoke test for the TokenHistory query shape — SKIPPED by default.
 *
 * Run with:  FORGE_LIVE=1 pnpm exec vitest run lib/repo/token-history.live.test.ts
 *
 * Proves the operand encoding + index shape {@link readTokenHistory} depends on are accepted
 * by the *deployed* system TokenHistory contract: `tokenId` is IDENTIFIER-typed, so the
 * where-operand must be a base58 id (NOT the base64 byteArray form used for hash/oid fields),
 * and `(tokenId, $createdAt)` is a valid index. A base64 operand is rejected live with
 * "could not be decoded from base 58". Never gates CI (WASM/network flaky).
 */

import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { TOKEN_HISTORY_CONTRACT_ID } from '../constants'
import { evoSdkService, queryDocumentsWithProof } from '../sdk'

const LIVE = process.env['FORGE_LIVE'] === '1'

describe.skipIf(!LIVE)('live TokenHistory query shape', () => {
  it(
    'accepts a base58 tokenId== operand with orderBy $createdAt on the mint type',
    async () => {
      await evoSdkService.initialize({ network: 'testnet', contractIds: [], timeoutMs: 15000 })
      const sdk = evoSdkService.getSdk()

      // Arbitrary 32-byte tokenId as base58 — we assert only that the operand encoding + index
      // are accepted by the live contract, not the (expected-empty) results.
      const tokenB58 = base58Encode(new Uint8Array(32).fill(7))
      const { documents } = await queryDocumentsWithProof(sdk, {
        dataContractId: TOKEN_HISTORY_CONTRACT_ID.testnet as string,
        documentTypeName: 'mint',
        where: [['tokenId', '==', tokenB58]],
        orderBy: [['$createdAt', 'asc']],
        limit: 5,
      })
      expect(Array.isArray(documents)).toBe(true)
    },
    30000,
  )
})
