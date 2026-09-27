/**
 * A wallet session: the key picked per contract, a missing forge-collab grant, a second grant
 * added and kept (sealed) across a lock and unlock, and the unlimited-key flag. The chain is a
 * fake; the vault is the real one (in-memory IndexedDB).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS } from '../constants'
import { resetMemoryStores } from '../idb'
import { AuthController, MissingGrantError } from './controller'
import type { WalletKey } from './key-registration'
import { bytesToHex } from '@noble/hashes/utils.js'
import { decodeWif, encodeWif } from './wif'
import { lockVault } from './vault'

vi.mock('../sdk/write', async (orig) => {
  const real = await orig<typeof import('../sdk/write')>()
  return {
    ...real,
    // The fake keys compare private keys by WIF: no wasm needed.
    findSigningKey: async (identity: { publicKeys: FakeKey[] }, wif: string) => {
      const k = identity.publicKeys.find((x) => x.wif === wif && x.disabledAt === undefined)
      return k ? { publicKey: {}, keyId: k.keyId, securityLevel: 2 } : null
    },
  }
})
// Whatever network this test run is built for, the session is on devnet with the moutai
// forge-v2 contracts (the default testnet build has none yet).
vi.mock('../constants', async (orig) => {
  const real = await orig<typeof import('../constants')>()
  const { DEPLOYMENTS, forgeV2Ids } = await import('../deployments')
  const devnet = { ...real.NETWORKS.devnet, key: 'devnet-moutai', v2: forgeV2Ids(DEPLOYMENTS['devnet-moutai']) }
  return { ...real, NETWORKS: { ...real.NETWORKS, devnet } }
})
vi.mock('@dashevo/evo-sdk', () => ({
  PrivateKey: { fromWIF: (wif: string) => ({ toBytes: () => new TextEncoder().encode(wif), free: () => undefined }) },
}))

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
const FORGE = NETWORKS[NET].v2
const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const wifOf = (n: number): string => encodeWif(new Uint8Array(32).fill(n), NET)

function key(keyId: number, wif: string, bounds: { $type: string; id: string } | null, limits: Partial<FakeKey> = {}): FakeKey {
  return {
    keyId,
    wif,
    purposeNumber: 0,
    securityLevelNumber: 2,
    ...limits,
    ...(bounds ? { contractBounds: { toJSON: () => bounds } } : {}),
    // Real private-key bytes (what controlsKey decodes from the WIF).
    validatePrivateKey: (bytes) => bytesToHex(bytes) === bytesToHex(decodeWif(wif).privateKey),
  }
}

describe('wallet session', () => {
  const forge = FORGE!
  let keys: FakeKey[]
  let controller: AuthController
  const sdk = {
    identities: {
      fetch: async () => ({ balance: 10n ** 11n, publicKeys: keys, getPublicKeyById: () => ({}) }),
      keysRemainingBudgets: async () => new Map(),
    },
  } as unknown as EvoSDK
  const walletKey = (keyId: number, wif: string, scope: WalletKey['scope']): WalletKey => ({ keyId, wif, scope, limits: null })

  beforeEach(() => {
    resetMemoryStores()
    lockVault()
    keys = [key(0, wifOf(1), null, { securityLevelNumber: 0 }), key(5, wifOf(5), { $type: 'singleContract', id: forge.core })]
    controller = new AuthController(async () => sdk, NET)
  })

  it('signs forge-core with the wallet key and asks for a forge-collab grant', async () => {
    const s = await controller.adoptWalletKeys(ID, [walletKey(5, wifOf(5), { core: true, collab: false, unbounded: false })], { passphrase: 'correct horse battery' })
    expect(s.grants).toEqual({ core: true, collab: false })
    expect(s.unlimited).toBe(true)
    const auth = controller.writeAuth!
    expect(auth.getSigningKeyWif(forge.core)).toBe(wifOf(5))
    expect(() => auth.getSigningKeyWif(forge.collab)).toThrow(MissingGrantError)
  }, 30_000)

  it('adds a forge-collab grant, which survives a lock and unlock (sealed beside the key)', async () => {
    await controller.adoptWalletKeys(ID, [walletKey(5, wifOf(5), { core: true, collab: false, unbounded: false })], { passphrase: 'correct horse battery' })
    keys.push(key(6, wifOf(6), { $type: 'singleContract', id: forge.collab }))
    const s = await controller.addWalletGrant(ID, walletKey(6, wifOf(6), { core: false, collab: true, unbounded: false }), forge.collab)
    expect(s.grants).toEqual({ core: true, collab: true })
    expect(controller.writeAuth!.getSigningKeyWif(forge.collab)).toBe(wifOf(6))
    controller.logout()
    await controller.unlock(ID, { passphrase: 'correct horse battery' })
    expect(controller.writeAuth!.getSigningKeyWif(forge.core)).toBe(wifOf(5))
    expect(controller.writeAuth!.getSigningKeyWif(forge.collab)).toBe(wifOf(6))
  }, 60_000)

  it('drops a grant whose key was disabled on chain, and one that no longer matches its contract', async () => {
    keys.push(key(6, wifOf(6), { $type: 'singleContract', id: forge.collab }))
    await controller.adoptWalletKeys(
      ID,
      [walletKey(5, wifOf(5), { core: true, collab: false, unbounded: false }), walletKey(6, wifOf(6), { core: false, collab: true, unbounded: false })],
      { passphrase: 'correct horse battery' },
    )
    expect(controller.writeAuth!.getSigningKeyWif(forge.collab)).toBe(wifOf(6))
    keys[2]!.disabledAt = 1n
    controller.logout()
    const s = await controller.unlock(ID, { passphrase: 'correct horse battery' }).then(() => controller.getState().session!)
    expect(s.grants).toEqual({ core: true, collab: false })
    expect(() => controller.writeAuth!.getSigningKeyWif(forge.collab)).toThrow(MissingGrantError)
  }, 60_000)

  it('a group-bound key with limits covers both contracts and is not flagged', async () => {
    keys[1] = key(5, wifOf(5), { $type: 'contractGroup', id: forge.group }, { totalBudget: 5n, expiresAt: BigInt(Date.now() + 1e9) })
    const s = await controller.adoptWalletKeys(
      ID,
      [{ keyId: 5, wif: wifOf(5), scope: { core: true, collab: true, unbounded: false }, limits: { remaining: 5n, total: 5n, expiresAt: Date.now() + 1e9 } }],
      { passphrase: 'correct horse battery' },
    )
    expect(s.grants).toEqual({ core: true, collab: true })
    expect(s.unlimited).toBe(false)
    expect(controller.writeAuth!.getSigningKeyWif(forge.collab)).toBe(wifOf(5))
  }, 30_000)

  it('files an unbounded key granted for forge-collab under forge-collab (no grant loop)', async () => {
    await controller.adoptWalletKeys(ID, [walletKey(5, wifOf(5), { core: true, collab: false, unbounded: false })], { passphrase: 'correct horse battery' })
    keys.push(key(6, wifOf(6), null))
    const s = await controller.addWalletGrant(ID, walletKey(6, wifOf(6), { core: true, collab: true, unbounded: true }), forge.collab)
    expect(s.grants).toEqual({ core: true, collab: true })
    expect(s.unbounded).toBe(true)
    expect(controller.writeAuth!.getSigningKeyWif(forge.collab)).toBe(wifOf(6))
  }, 30_000)

  it('signs only Forge writes with a vault key', async () => {
    await controller.adoptWalletKeys(ID, [walletKey(5, wifOf(5), { core: true, collab: false, unbounded: false })], { passphrase: 'correct horse battery' })
    expect(() => controller.writeAuth!.getSigningKeyWif()).toThrow(/only Dash Forge/)
    expect(() => controller.writeAuth!.getSigningKeyWif('H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ')).toThrow(/only Dash Forge/)
  }, 30_000)

  it('refuses to replace a locked wallet-key vault (its keys could not be disabled)', async () => {
    await controller.adoptWalletKeys(ID, [walletKey(5, wifOf(5), { core: true, collab: false, unbounded: false })], { passphrase: 'correct horse battery' })
    controller.logout()
    await expect(
      controller.adoptWalletKeys(ID, [walletKey(5, wifOf(5), { core: true, collab: false, unbounded: false })], { passphrase: 'another passphrase' }),
    ).rejects.toThrow(/Unlock it first/)
  }, 30_000)

  it('refuses to open a session on a key bound to another app', async () => {
    keys[1] = key(5, wifOf(5), { $type: 'singleContract', id: 'H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ' })
    await expect(
      controller.adoptWalletKeys(ID, [walletKey(5, wifOf(5), { core: true, collab: false, unbounded: false })], { passphrase: 'correct horse battery' }),
    ).rejects.toThrow(/outside Dash Forge/)
  }, 30_000)
})
