/**
 * The forge-user key at each rotation from a recovery phrase is the one the Dash wallets derive
 * (DIP-15 application encryption key, the ids as DIP-14 256-bit children): the Rust generator's
 * vectors (`forge-contracts/fixtures/user-sync/rotation.json`) for testnet and mainnet.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import { decodeIdentifier } from './base58'
import { appEncryptionKeyPath, deriveAppEncryptionKey } from './hd'
import { phraseSyncKeys } from './sync-key-move'

interface Vector {
  readonly network: 'testnet' | 'mainnet'
  readonly rotation: number
  readonly path: string
  readonly privateKeyHex: string
  readonly publicKeyHex: string
}

interface WalletVector {
  readonly network: 'testnet' | 'mainnet'
  readonly identityIdHex: string
  readonly contractIdHex: string
  readonly rotation: number
  readonly publicKeyHex: string
}

const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, '../../../forge-contracts/fixtures/user-sync/rotation.json'), 'utf8')) as {
  readonly mnemonic: string
  readonly identityId: string
  readonly contractId: string
  readonly vectors: readonly Vector[]
  readonly walletVectors?: readonly WalletVector[]
  readonly legacyVectors?: readonly Omit<Vector, 'rotation'>[]
  readonly walletLegacyVectors?: readonly Omit<WalletVector, 'rotation'>[]
}

describe('the forge-user key at rotation r', () => {
  it('covers both networks and rotations 0 to 2, and the legacy path', () => {
    for (const network of ['testnet', 'mainnet']) {
      expect(FIXTURE.vectors.filter((v) => v.network === network).map((v) => v.rotation)).toEqual([0, 1, 2])
      expect(FIXTURE.legacyVectors?.filter((v) => v.network === network)).toHaveLength(1)
    }
  })

  for (const v of FIXTURE.vectors) {
    it(`${v.network} rotation ${v.rotation}`, async () => {
      const id = decodeIdentifier(FIXTURE.identityId)
      const contract = decodeIdentifier(FIXTURE.contractId)
      expect(appEncryptionKeyPath(v.network, id, contract, v.rotation)).toBe(v.path)
      const k = await deriveAppEncryptionKey(FIXTURE.mnemonic, v.network, id, contract, v.rotation)
      expect(bytesToHex(k.secret)).toBe(v.privateKeyHex)
      expect(bytesToHex(k.pub)).toBe(v.publicKeyHex)
      const viaMove = await phraseSyncKeys(FIXTURE.mnemonic, v.network, FIXTURE.identityId, FIXTURE.contractId)(v.rotation)
      expect(bytesToHex(viaMove.pub)).toBe(v.publicKeyHex)
    }, 60_000)
  }

  for (const v of FIXTURE.walletVectors ?? []) {
    it(`the wallet's own vector: ${v.network} ${v.identityIdHex.slice(0, 8)}… rotation ${v.rotation}`, async () => {
      const k = await deriveAppEncryptionKey(FIXTURE.mnemonic, v.network, hexToBytes(v.identityIdHex), hexToBytes(v.contractIdHex), v.rotation)
      expect(bytesToHex(k.pub)).toBe(v.publicKeyHex)
    }, 60_000)
  }

  for (const v of FIXTURE.legacyVectors ?? []) {
    it(`${v.network} legacy (no rotation level)`, async () => {
      const id = decodeIdentifier(FIXTURE.identityId)
      const contract = decodeIdentifier(FIXTURE.contractId)
      expect(appEncryptionKeyPath(v.network, id, contract, 'legacy')).toBe(v.path)
      const k = await deriveAppEncryptionKey(FIXTURE.mnemonic, v.network, id, contract, 'legacy')
      expect(bytesToHex(k.secret)).toBe(v.privateKeyHex)
      expect(bytesToHex(k.pub)).toBe(v.publicKeyHex)
    }, 60_000)
  }

  for (const v of FIXTURE.walletLegacyVectors ?? []) {
    it(`the wallet's own legacy vector: ${v.network} ${v.identityIdHex.slice(0, 8)}…`, async () => {
      const k = await deriveAppEncryptionKey(FIXTURE.mnemonic, v.network, hexToBytes(v.identityIdHex), hexToBytes(v.contractIdHex), 'legacy')
      expect(bytesToHex(k.pub)).toBe(v.publicKeyHex)
    }, 60_000)
  }
})
