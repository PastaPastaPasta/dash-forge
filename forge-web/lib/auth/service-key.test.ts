/**
 * The key a signed request to an optional Forge service carries (`docs/design/service-auth.md`):
 * the id found on chain for the session's WIF, and its key type, so a wallet's ECDSA_HASH160
 * grant can send its public key.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS } from '../constants'
import { resetMemoryStores } from '../idb'
import { AuthController } from './controller'
import { encodeWif } from './wif'
import { lockVault, storeInVault } from './vault'

vi.mock('../sdk/write', async (orig) => {
  const real = await orig<typeof import('../sdk/write')>()
  return {
    ...real,
    findSigningKey: async (identity: { publicKeys: FakeKey[] }, wif: string) => {
      const k = identity.publicKeys.find((x) => x.wif === wif && x.disabledAt === undefined)
      return k ? { publicKey: {}, keyId: k.keyId, securityLevel: 2 } : null
    },
  }
})
vi.mock('../constants', async (orig) => {
  const real = await orig<typeof import('../constants')>()
  const { DEPLOYMENTS, forgeV2Ids } = await import('../deployments')
  const devnet = { ...real.NETWORKS.devnet, key: 'devnet-moutai', v2: forgeV2Ids(DEPLOYMENTS['devnet-moutai']) }
  return { ...real, NETWORKS: { ...real.NETWORKS, devnet } }
})
vi.mock('./wif', async (orig) => {
  const real = await orig<typeof import('./wif')>()
  return { ...real, controlsKey: (k: FakeKey, wif: string) => k.wif === wif }
})

interface FakeKey {
  keyId: number
  wif: string
  purposeNumber: number
  securityLevelNumber: number
  keyTypeNumber: number
  disabledAt?: bigint
  totalBudget?: bigint
  expiresAt?: bigint
  contractBounds?: { toJSON(): { $type: string; id: string } }
  validatePrivateKey(bytes: Uint8Array): boolean
}

const NET = 'devnet' as const
const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const PASS = { passphrase: 'correct horse battery' }
const wifOf = (n: number): string => encodeWif(new Uint8Array(32).fill(n), NET)
const FORGE = NETWORKS[NET].v2!

function key(keyId: number, wif: string, keyTypeNumber: number): FakeKey {
  return {
    keyId,
    wif,
    purposeNumber: 0,
    securityLevelNumber: 2,
    keyTypeNumber,
    totalBudget: 5_000_000_000n,
    expiresAt: BigInt(Date.now() + 1e9),
    contractBounds: { toJSON: () => ({ $type: 'contractGroup', id: FORGE.group }) },
    validatePrivateKey: () => false,
  }
}

describe('serviceKey', () => {
  let keys: FakeKey[]
  let controller: AuthController
  const sdk = {
    identities: {
      fetch: async () => ({ balance: 10n ** 11n, publicKeys: keys, getPublicKeyById: () => ({}) }),
      keysRemainingBudgets: async () => new Map(),
    },
  } as unknown as EvoSDK

  beforeEach(() => {
    resetMemoryStores()
    lockVault()
    controller = new AuthController(async () => sdk, NET)
  })

  it('carries a stored key’s id and type', async () => {
    keys = [key(5, wifOf(5), 0)]
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, PASS)
    lockVault()
    await controller.unlock(ID, PASS)
    expect(controller.serviceKey()).toEqual({ identityId: ID, keyId: 5, wif: wifOf(5), keyType: 0 })
  }, 90_000)

  it('drops the session’s key type when the stored key is not the session’s key', async () => {
    keys = [key(5, wifOf(5), 2), key(6, wifOf(6), 0)]
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, PASS)
    lockVault()
    await controller.unlock(ID, PASS)
    // A renewal stored key 6; the session has not reopened on it yet.
    await storeInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(6) }, PASS)
    expect(controller.serviceKey()).toEqual({ identityId: ID, keyId: 6, wif: wifOf(6) })
  }, 90_000)

  it('names a pasted key by the id found on chain, with its HASH160 type', async () => {
    keys = [key(0, wifOf(1), 0), key(7, wifOf(7), 2)]
    await controller.loginWithRawKey(ID, wifOf(7))
    expect(controller.serviceKey()).toEqual({ identityId: ID, keyId: 7, wif: wifOf(7), keyType: 2 })
  }, 90_000)
})
