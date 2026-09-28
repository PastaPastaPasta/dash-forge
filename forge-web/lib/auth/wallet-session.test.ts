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
import { lockVault, stageInVault, stagedInfo, storeInVault } from './vault'

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
// The master-key updates: recorded, not sent. What a renewal or revoke would disable.
const chainCalls = vi.hoisted(() => ({ register: [] as unknown[], disable: [] as unknown[], revoke: [] as unknown[] }))
vi.mock('./limited-key', async (orig) => {
  const real = await orig<typeof import('./limited-key')>()
  return {
    ...real,
    registerLimitedKey: async (_sdk: unknown, params: { disableHeld?: unknown; replaceKeyId?: number }) => {
      chainCalls.register.push(params)
      return { keyId: 20, wif: encodeWif(new Uint8Array(32).fill(20), 'devnet'), limits: { remaining: 5n, total: 5n, expiresAt: Date.now() + 1e9 } }
    },
    disableHeldKeys: async (_sdk: unknown, params: unknown) => void chainCalls.disable.push(params),
    revokeLimitedKey: async (_sdk: unknown, params: unknown) => void chainCalls.revoke.push(params),
  }
})
vi.mock('./identity-file', async (orig) => {
  const real = await orig<typeof import('./identity-file')>()
  return { ...real, masterMaterialFromFile: () => ({ identityId: '5999iJiaZLMEb6KbjXYFDDYjwGWssatToUTJbXvXhxBp', networkKey: 'devnet-moutai', masterWif: 'MASTER', mnemonic: null }) }
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
const ID = '5999iJiaZLMEb6KbjXYFDDYjwGWssatToUTJbXvXhxBp'
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
    chainCalls.register.length = 0
    chainCalls.disable.length = 0
    chainCalls.revoke.length = 0
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

  it('drops a grant whose key was disabled on chain', async () => {
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
    ).rejects.toThrow(/Unlock first/)
  }, 30_000)

  const PASS = { passphrase: 'correct horse battery' }
  const coreKey = (): WalletKey => walletKey(5, wifOf(5), { core: true, collab: false, unbounded: false })

  it('a forge-collab grant answered by a group-bound key covers collab (scope, not the contract it was filed under)', async () => {
    await controller.adoptWalletKeys(ID, [coreKey()], PASS)
    keys.push(key(6, wifOf(6), { $type: 'contractGroup', id: forge.group }, { totalBudget: 5n, expiresAt: BigInt(Date.now() + 1e9) }))
    const s = await controller.addWalletGrant(ID, walletKey(6, wifOf(6), { core: true, collab: true, unbounded: false }), forge.collab)
    expect(s.grants).toEqual({ core: true, collab: true })
    expect(controller.writeAuth!.getSigningKeyWif(forge.collab)).toBe(wifOf(6))
    // Refuses a grant that does not cover what was asked for.
    keys.push(key(7, wifOf(7), { $type: 'singleContract', id: forge.core }))
    await expect(controller.addWalletGrant(ID, walletKey(7, wifOf(7), { core: true, collab: false, unbounded: false }), forge.collab)).rejects.toThrow(/does not cover/)
  }, 30_000)

  it('a returning wallet login keeps the forge-collab grant this browser already holds', async () => {
    await controller.adoptWalletKeys(ID, [coreKey()], PASS)
    keys.push(key(6, wifOf(6), { $type: 'singleContract', id: forge.collab }))
    await controller.addWalletGrant(ID, walletKey(6, wifOf(6), { core: false, collab: true, unbounded: false }), forge.collab)
    const again = await controller.adoptWalletKeys(ID, [coreKey()], PASS)
    expect(again.grants).toEqual({ core: true, collab: true })
  }, 30_000)

  it('a grant whose check fails keeps the session that was working', async () => {
    await controller.adoptWalletKeys(ID, [coreKey()], PASS)
    const before = controller.getState().session
    // Key 6 is not on the identity: the re-check after storing it fails.
    await expect(controller.addWalletGrant(ID, walletKey(6, wifOf(6), { core: false, collab: true, unbounded: false }), forge.collab)).rejects.toThrow(/approval was saved/)
    expect(controller.getState().session).toEqual(before)
    expect(controller.writeAuth!.getSigningKeyWif(forge.core)).toBe(wifOf(5))
  }, 30_000)

  it('renewing an unlocked wallet session disables every key this browser holds, in the same update', async () => {
    await controller.adoptWalletKeys(ID, [coreKey()], PASS)
    keys.push(key(6, wifOf(6), { $type: 'singleContract', id: forge.collab }))
    await controller.addWalletGrant(ID, walletKey(6, wifOf(6), { core: false, collab: true, unbounded: false }), forge.collab)
    keys.push(key(20, encodeWif(new Uint8Array(32).fill(20), 'devnet'), { $type: 'contractGroup', id: forge.group }, { totalBudget: 5n, expiresAt: BigInt(Date.now() + 1e9) }))
    await controller.importIdentity({ fileText: '{}' }, PASS)
    const call = chainCalls.register[0] as { disableHeld: { keyId: number; wif: string }[] }
    expect(call.disableHeld.map((h) => h.keyId).sort()).toEqual([5, 6])
  }, 30_000)

  it('refuses to renew or revoke a locked wallet vault (it could not disable the wallet keys)', async () => {
    await controller.adoptWalletKeys(ID, [coreKey()], PASS)
    controller.logout()
    await expect(controller.importIdentity({ fileText: '{}' }, PASS)).rejects.toThrow(/Unlock first/)
    await expect(controller.revokeStored(ID, { fileText: '{}' })).rejects.toThrow(/Unlock first/)
    expect(chainCalls.register).toHaveLength(0)
    expect(chainCalls.disable).toHaveLength(0)
  }, 30_000)

  it('revoking an unlocked wallet session disables its keys (not the Forge-key-only path)', async () => {
    await controller.adoptWalletKeys(ID, [coreKey()], PASS)
    await controller.revokeStored(ID, { fileText: '{}' })
    expect((chainCalls.disable[0] as { keys: { keyId: number }[] }).keys.map((k) => k.keyId)).toEqual([5])
    expect(chainCalls.revoke).toHaveLength(0)
  }, 30_000)

  it('never carries a pasted raw key into the vault, and a raw session is not an unlocked vault', async () => {
    const raw = wifOf(9)
    keys.push(key(9, raw, null, { securityLevelNumber: 1 }))
    await controller.loginWithRawKey(ID, raw)
    await controller.adoptWalletKeys(ID, [coreKey()], PASS)
    controller.logout()
    await controller.unlock(ID, PASS)
    const { unlockedSecret } = await import('./vault')
    expect(unlockedSecret(NET, ID)?.extra ?? []).toEqual([])
    // Locked wallet vault + a raw session for the same identity: renewal still refused.
    controller.logout()
    await controller.loginWithRawKey(ID, raw)
    await expect(controller.importIdentity({ fileText: '{}' }, PASS)).rejects.toThrow(/Unlock first/)
  }, 60_000)

  it('refuses to open a session on a key bound to another app', async () => {
    keys[1] = key(5, wifOf(5), { $type: 'singleContract', id: 'H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ' })
    await expect(
      controller.adoptWalletKeys(ID, [walletKey(5, wifOf(5), { core: true, collab: false, unbounded: false })], { passphrase: 'correct horse battery' }),
    ).rejects.toThrow(/outside Dash Forge/)
  }, 30_000)

  describe('a wallet login over an unfinished renewal (D-016)', () => {
    const renewalKey = (): FakeKey => key(7, wifOf(7), { $type: 'contractGroup', id: forge.group }, { totalBudget: 5n, expiresAt: BigInt(Date.now() + 1e9) })
    const OTHER = { passphrase: 'the renewal passphrase' }
    const discard = { discardPendingRenewal: true } as const

    it('keeps the given-up renewal key beside the wallet keys, never to sign, and the next renewal disables it', async () => {
      await stageInVault(NET, { identityId: ID, keyId: 7, wif: wifOf(7) }, PASS)
      keys.push(renewalKey())
      await expect(controller.adoptWalletKeys(ID, [coreKey()], PASS)).rejects.toThrow(/unfinished key renewal/)
      const s = await controller.adoptWalletKeys(ID, [coreKey()], PASS, discard)
      expect(await stagedInfo(NET, ID)).toBeNull()
      expect(s.heldOnly).toEqual([7])
      // It grants nothing: signing picks the wallet key, and a collab write has no key.
      expect(controller.writeAuth!.getSigningKeyWif(forge.core)).toBe(wifOf(5))
      expect(() => controller.writeAuth!.getSigningKeyWif(forge.collab)).toThrow(MissingGrantError)
      keys.push(key(20, encodeWif(new Uint8Array(32).fill(20), 'devnet'), { $type: 'contractGroup', id: forge.group }, { totalBudget: 5n, expiresAt: BigInt(Date.now() + 1e9) }))
      await controller.importIdentity({ fileText: '{}' }, PASS)
      const call = chainCalls.register[0] as { disableHeld: { keyId: number }[] }
      expect(call.disableHeld.map((h) => h.keyId).sort()).toEqual([5, 7])
    }, 60_000)

    it('is kept across a lock and unlock, and a revoke disables it too', async () => {
      await stageInVault(NET, { identityId: ID, keyId: 7, wif: wifOf(7) }, PASS)
      keys.push(renewalKey())
      await controller.adoptWalletKeys(ID, [coreKey()], PASS, discard)
      controller.logout()
      expect((await controller.unlock(ID, PASS)).heldOnly).toEqual([7])
      await controller.revokeStored(ID, { fileText: '{}' })
      expect((chainCalls.disable[0] as { keys: { keyId: number }[] }).keys.map((k) => k.keyId).sort()).toEqual([5, 7])
    }, 60_000)

    it("a renewal protected differently asks for its own passphrase, then keeps its key", async () => {
      await stageInVault(NET, { identityId: ID, keyId: 7, wif: wifOf(7) }, OTHER)
      keys.push(renewalKey())
      await expect(controller.adoptWalletKeys(ID, [coreKey()], PASS, discard)).rejects.toThrow(/passphrase or use the passkey you chose for that renewal/)
      expect(await stagedInfo(NET, ID)).not.toBeNull()
      await expect(controller.adoptWalletKeys(ID, [coreKey()], PASS, { ...discard, renewalUnlock: { passphrase: 'wrong wrong wrong' } })).rejects.toThrow(/did not open/)
      const s = await controller.adoptWalletKeys(ID, [coreKey()], PASS, { ...discard, renewalUnlock: OTHER })
      expect(s.heldOnly).toEqual([7])
    }, 90_000)

    it('the user may continue without the renewal key; it is then not held', async () => {
      await stageInVault(NET, { identityId: ID, keyId: 7, wif: wifOf(7) }, OTHER)
      keys.push(renewalKey())
      const s = await controller.adoptWalletKeys(ID, [coreKey()], PASS, { ...discard, dropUnopened: true })
      expect(s.heldOnly).toBeUndefined()
      expect(await stagedInfo(NET, ID)).toBeNull()
    }, 60_000)

    it('a wallet login that cannot store keeps the stage (never gone before its key is held)', async () => {
      // The old vault holds wallet keys and is locked: the login is refused before anything is dropped.
      await controller.adoptWalletKeys(ID, [coreKey()], PASS)
      keys.push(key(6, wifOf(6), { $type: 'singleContract', id: forge.collab }))
      await controller.addWalletGrant(ID, walletKey(6, wifOf(6), { core: false, collab: true, unbounded: false }), forge.collab)
      controller.logout()
      await stageInVault(NET, { identityId: ID, keyId: 7, wif: wifOf(7) }, PASS)
      keys.push(renewalKey())
      await expect(controller.adoptWalletKeys(ID, [coreKey()], PASS, discard)).rejects.toThrow(/Unlock first/)
      expect(await stagedInfo(NET, ID)).toMatchObject({ keyId: 7 })
    }, 60_000)

    it("the Settings discard keeps the renewal's key with its passphrase, and drops it without", async () => {
      await controller.adoptWalletKeys(ID, [coreKey()], PASS)
      await stageInVault(NET, { identityId: ID, keyId: 7, wif: wifOf(7) }, OTHER)
      keys.push(renewalKey())
      await expect(controller.abandonPendingRenewal(ID, { passphrase: 'wrong wrong wrong' })).rejects.toThrow(/did not open/)
      expect(await stagedInfo(NET, ID)).not.toBeNull()
      await controller.abandonPendingRenewal(ID, OTHER)
      expect(await stagedInfo(NET, ID)).toBeNull()
      expect(controller.getState().session?.heldOnly).toEqual([7])
      controller.logout()
      expect((await controller.unlock(ID, PASS)).heldOnly).toEqual([7])
      // Without the passphrase: dropped, nothing held.
      await stageInVault(NET, { identityId: ID, keyId: 8, wif: wifOf(8) }, OTHER)
      await controller.abandonPendingRenewal(ID)
      expect(await stagedInfo(NET, ID)).toBeNull()
    }, 90_000)

    it('a renewal key that never landed is not listed', async () => {
      await stageInVault(NET, { identityId: ID, keyId: 7, wif: wifOf(7) }, PASS)
      const s = await controller.adoptWalletKeys(ID, [coreKey()], PASS, discard)
      expect(s.heldOnly).toBeUndefined()
    }, 60_000)
  })

  it('a reopened create sheet also returns the wallet grants held, for its renewal to disable', async () => {
    await controller.adoptWalletKeys(ID, [coreKey()], PASS)
    keys.push(key(6, wifOf(6), { $type: 'singleContract', id: forge.collab }))
    await controller.addWalletGrant(ID, walletKey(6, wifOf(6), { core: false, collab: true, unbounded: false }), forge.collab)
    controller.logout()
    expect(await controller.storedKeyFor(ID, PASS)).toEqual({ keyId: 5, wif: wifOf(5), alsoHeld: [{ keyId: 6, wif: wifOf(6) }] })
  }, 60_000)

  it('a reopened create sheet reads the stored key back with the protection chosen now (L-06)', async () => {
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, PASS)
    lockVault()
    expect(await controller.storedKeyFor(ID, PASS)).toEqual({ keyId: 5, wif: wifOf(5) })
    lockVault()
    expect(await controller.storedKeyFor(ID, { passphrase: 'another passphrase' })).toBeNull()
    expect(await controller.storedKeyFor('4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF', PASS)).toBeNull()
  }, 60_000)
})
