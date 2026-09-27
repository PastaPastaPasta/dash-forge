/**
 * D-016 recovery through the controller: a key staged and registered by a tab that did not
 * live to commit it is finished on the next unlock, including on a device that holds only the
 * staged key (a first import); a key Platform does not show yet is kept, never deleted.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS } from '../constants'
import { resetMemoryStores } from '../idb'
import { AuthController } from './controller'
import { encodeWif } from './wif'
import { hasStaged, listVaults, lockVault, stageInVault, storeInVault } from './vault'

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
vi.mock('../view/retry', () => ({ retryWhileMissing: async <T,>(read: () => Promise<T | null>) => read() }))
vi.mock('./wif', async (orig) => {
  const real = await orig<typeof import('./wif')>()
  return { ...real, controlsKey: (k: FakeKey, wif: string) => k.wif === wif }
})

interface FakeKey {
  keyId: number
  wif: string
  purposeNumber: number
  securityLevelNumber: number
  disabledAt?: bigint
  totalBudget?: bigint
  expiresAt?: bigint
  contractBounds?: { toJSON(): { $type: string; id: string } }
  validatePrivateKey(bytes: Uint8Array): boolean
}

const NET = 'devnet' as const
const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const PASS = { passphrase: 'correct horse battery' }
const OTHER = { passphrase: 'another passphrase for renew' }
const wifOf = (n: number): string => encodeWif(new Uint8Array(32).fill(n), NET)
const FORGE = NETWORKS[NET].v2!

function browserKey(keyId: number, wif: string): FakeKey {
  return {
    keyId,
    wif,
    purposeNumber: 0,
    securityLevelNumber: 2,
    totalBudget: 5_000_000_000n,
    expiresAt: BigInt(Date.now() + 1e9),
    contractBounds: { toJSON: () => ({ $type: 'contractGroup', id: FORGE.group }) },
    validatePrivateKey: () => false,
  }
}

describe('finishing a renewal on unlock (D-016)', () => {
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
    keys = [browserKey(5, wifOf(5))]
    controller = new AuthController(async () => sdk, NET)
  })

  it('a registered staged key replaces the old one on the next unlock', async () => {
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, PASS)
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, PASS)
    // The update landed (key 6 added, key 5 disabled); the tab closed before the commit.
    keys = [{ ...browserKey(5, wifOf(5)), disabledAt: 1n }, browserKey(6, wifOf(22))]
    lockVault()
    const session = await controller.unlock(ID, PASS)
    expect(session.keyId).toBe(6)
    expect(await hasStaged(NET, ID)).toBe(false)
  }, 90_000)

  it('a first import that only staged its key is offered and finished (review 1)', async () => {
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, PASS)
    keys = [browserKey(6, wifOf(22))]
    lockVault()
    expect((await listVaults(NET)).map((v) => v.identityId)).toEqual([ID])
    const session = await controller.unlock(ID, PASS)
    expect(session.keyId).toBe(6)
    expect(await hasStaged(NET, ID)).toBe(false)
  }, 90_000)

  it('a staged key Platform does not show yet is kept, and unlock says to try again (review 2)', async () => {
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, PASS)
    keys = []
    lockVault()
    await expect(controller.unlock(ID, PASS)).rejects.toThrow(/not on Platform yet/)
    expect(await hasStaged(NET, ID)).toBe(true)
  }, 90_000)

  it('a renewal protected with another passphrase: that passphrase finishes it (review B1)', async () => {
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, PASS)
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, OTHER)
    keys = [{ ...browserKey(5, wifOf(5)), disabledAt: 1n }, browserKey(6, wifOf(22))]
    lockVault()
    const session = await controller.unlock(ID, OTHER)
    expect(session.keyId).toBe(6)
    expect(await hasStaged(NET, ID)).toBe(false)
  }, 90_000)

  it('the old passphrase still opens the current key, with a notice, when the renewal is protected differently (review B1)', async () => {
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, PASS)
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, OTHER)
    // The renewal never landed: the old key is still live.
    keys = [browserKey(5, wifOf(5))]
    lockVault()
    const session = await controller.unlock(ID, PASS)
    expect(session.keyId).toBe(5)
    expect(controller.getState().notice).toMatch(/unfinished key renewal/)
    expect(await hasStaged(NET, ID)).toBe(true)
  }, 90_000)

  it('a staged key that landed and has since expired is adopted, so a normal renewal can replace it (review B2)', async () => {
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, PASS)
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, PASS)
    keys = [{ ...browserKey(5, wifOf(5)), disabledAt: 1n }, { ...browserKey(6, wifOf(22)), disabledAt: 2n }]
    lockVault()
    // Adopted (the session then fails as a disabled key does, pointing to renew).
    await expect(controller.unlock(ID, PASS)).rejects.toThrow(/renew/)
    expect(await hasStaged(NET, ID)).toBe(false)
    expect((await listVaults(NET)).find((v) => v.identityId === ID)?.keyId).toBe(6)
  }, 90_000)

  it('the user can give up a pending renewal and keep signing in another way', async () => {
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, PASS)
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, OTHER)
    expect(await controller.pendingRenewal(ID)).toMatchObject({ keyId: 6 })
    await controller.abandonPendingRenewal(ID)
    expect(await controller.pendingRenewal(ID)).toBeNull()
  }, 60_000)

  it("the renewal's passphrase, for a renewal that never landed, says it was discarded (not \"try again\")", async () => {
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, PASS)
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, OTHER)
    keys = [browserKey(5, wifOf(5)), browserKey(6, wifOf(40))]
    lockVault()
    await expect(controller.unlock(ID, OTHER)).rejects.toThrow(/never reached Platform, so it was discarded/)
    expect(await hasStaged(NET, ID)).toBe(false)
    expect((await controller.unlock(ID, PASS)).keyId).toBe(5)
  }, 90_000)

  it('a staged key whose id another key took is dropped (proof it was never registered)', async () => {
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, PASS)
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, PASS)
    keys = [browserKey(5, wifOf(5)), browserKey(6, wifOf(40))]
    lockVault()
    const session = await controller.unlock(ID, PASS)
    expect(session.keyId).toBe(5)
    expect(await hasStaged(NET, ID)).toBe(false)
  }, 90_000)
})
