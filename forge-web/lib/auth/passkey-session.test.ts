/**
 * Passkeys that hold a key on Platform, through the controller (PLAN-passkey-vault.md §3, §5): add
 * one on a signed-in device, sign in with it on a new one (kept in the browser vault under the same
 * passkey, its PRF input as the salt), the refusals (a browser-only passkey, a planted entry, a
 * browser that already keeps a key, the cap), re-seals that touch only this device's own entries,
 * removal that signals only this device's credentials, the revoke hook, and the wipes.
 *
 * The chain is a fake whose keys both the session checks and the vault's port read; the port's
 * storage is the core's in-memory one; WebAuthn is the core's software authenticator. The browser
 * vault is the real one (in-memory IndexedDB, a fake window).
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS } from '../constants'
import { idbGet, resetMemoryStores } from '../idb'
import type { WasmKey } from '../sdk/facade'
import { UnconfirmedWriteError } from '../sdk/write'
import {
  PasskeyError,
  prfInput,
  recipientFromPrf,
  sealEntry,
  userHandleFor,
  type OnChainKey,
  type PasskeyAssertion,
} from '../vendor/platform-auth/passkey-vault'
import { fakePasskeyAdapter, type FakePasskeyAdapter } from '../vendor/platform-auth/passkey-vault/__fixtures__/fake-passkey'
import { MemoryVaultPort } from '../vendor/platform-auth/passkey-vault/__fixtures__/memory-port'
import { decodeIdentifier } from './base58'
import { AuthController } from './controller'
import type { WalletKey } from './key-registration'
import { readMarkers, readPending } from './passkey-vault/markers'
import { FORGE_BUNDLE_CODEC, FORGE_BUNDLE_FORMAT, FORGE_VAULT_PROFILE } from './passkey-vault/profile'
import { credentialName, onChainKeyOf } from './passkey-vault/port'
import { vaultPasskeyFailure } from './passkey-vault/service'
import { listVaults, releaseUnlocked, storeEncryptionKey } from './vault'
import { encodeWif } from './wif'

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
  const devnet = { ...real.NETWORKS.devnet, key: 'devnet-sakura', v2: forgeV2Ids(DEPLOYMENTS['devnet-sakura']) }
  return { ...real, NETWORKS: { ...real.NETWORKS, devnet } }
})
vi.mock('./group-trust', async (orig) => ({ ...(await orig<typeof import('./group-trust')>()), assertGroupHolds: async () => ({ unknown: [], unchecked: [], notice: null }) }))
vi.mock('../view/retry', () => ({ retryWhileMissing: async <T,>(read: () => Promise<T | null>) => read(), retryUntil: async <T,>(read: () => Promise<T>) => read() }))
vi.mock('./wif', async (orig) => {
  const real = await orig<typeof import('./wif')>()
  return { ...real, controlsKey: (k: FakeKey, wif: string) => k.wif === wif }
})
vi.mock('./identity-file', async (orig) => {
  const real = await orig<typeof import('./identity-file')>()
  return { ...real, masterMaterialFromFile: () => ({ identityId: '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD', networkKey: 'devnet-sakura', masterWif: 'MASTER', mnemonic: null }) }
})
const disabled = vi.hoisted(() => [] as number[][])
vi.mock('./limited-key', async (orig) => {
  const real = await orig<typeof import('./limited-key')>()
  return {
    ...real,
    // A renewal registers key 20 (recorded, not sent).
    registerLimitedKey: async (_sdk: unknown, params: { persist?: (k: { keyId: number; wif: string }) => Promise<void> }) => {
      const key = { keyId: 20, wif: encodeWif(new Uint8Array(32).fill(20), 'devnet') }
      await params.persist?.(key)
      return { ...key, limits: { remaining: 5n, total: 5n, expiresAt: Date.now() + 1e9 } }
    },
    disableIdentityKeys: async (_sdk: unknown, params: { keyIds: number[] }) => {
      disabled.push(params.keyIds)
      return true
    },
  }
})
// Adopting an encryption key checks it through the SDK's wasm keys: recorded here instead.
const adopted = vi.hoisted(() => [] as Uint8Array[])
vi.mock('./encryption-key', async (orig) => ({
  ...(await orig<typeof import('./encryption-key')>()),
  adoptEncryptionKey: async (_sdk: unknown, _n: unknown, _id: unknown, _core: unknown, secret: Uint8Array) => {
    adopted.push(secret.slice())
    secret.fill(0)
    return 9
  },
}))

interface FakeKey extends WasmKey {
  wif: string
}

const NET = 'devnet' as const
const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const OWNER = decodeIdentifier(ID)
const FORGE = NETWORKS[NET].v2!
const META = decodeIdentifier(FORGE.meta!)
const PRF_INPUT = prfInput(FORGE_VAULT_PROFILE, META)
const sk = (n: number) => new Uint8Array(32).fill(n)
const wifOf = (n: number): string => encodeWif(sk(n), NET)
const pubHex = (n: number) => bytesToHex(secp256k1.getPublicKey(sk(n), true))
/** A browser-vault protection for the wallet sign-in (no Argon2: fast). */
const PASSKEY = { passkey: { credentialId: new Uint8Array([1]), prfSalt: new Uint8Array(32), output: new Uint8Array(32).fill(9) } }
const WAIT = { timeout: 15_000, interval: 20 }

function fakeWindow(): unknown {
  const data = new Map<string, string>()
  const localStorage = {
    get length() {
      return data.size
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  }
  const win: Record<string, unknown> = { localStorage, location: { hostname: 'forge.dashhq.org', pathname: '/' }, addEventListener: () => undefined, isSecureContext: true }
  win.top = win
  win.self = win
  return win
}

/** A group-bound HIGH key with a budget and an expiry: a Forge limited key or a v2 wallet key. */
function groupKey(keyId: number): FakeKey {
  return {
    keyId,
    wif: wifOf(keyId),
    purposeNumber: 0,
    securityLevelNumber: 2,
    keyTypeNumber: 0,
    data: pubHex(keyId),
    totalBudget: 5_000_000_000n,
    expiresAt: BigInt(Date.now() + 90 * 24 * 3600 * 1000),
    contractBounds: { toJSON: () => ({ $type: 'contractGroup', id: FORGE.group }) },
    validatePrivateKey: () => false,
  }
}

const grantOf = (k: FakeKey): WalletKey => ({
  keyId: k.keyId,
  wif: k.wif,
  scope: { core: true, collab: true, community: true, meta: true, unbounded: false },
  limits: { remaining: k.totalBudget!, total: k.totalBudget!, expiresAt: Number(k.expiresAt) },
})

/** The core's in-memory port, reading the same keys as the fake chain (through the real mapping). */
class ChainPort extends MemoryVaultPort {
  /** The next create lands, but its answer is lost (an unconfirmed write). */
  loseNextAnswer = false
  constructor(private readonly chain: () => FakeKey[]) {
    super()
  }
  override async put(o: Parameters<MemoryVaultPort['put']>[0]): Promise<void> {
    await super.put(o)
    if (this.loseNextAnswer) {
      this.loseNextAnswer = false
      throw new UnconfirmedWriteError('doc')
    }
  }
  override async identityKeys(): Promise<OnChainKey[]> {
    return this.chain().flatMap((k) => {
      const mapped = onChainKeyOf(k, k.totalBudget)
      return mapped ? [mapped] : []
    })
  }
}

describe('passkeys that hold a key on Platform', () => {
  let keys: FakeKey[]
  let port: ChainPort
  let adapter: FakePasskeyAdapter
  /** Every PRF output the authenticator handed out (each must be wiped once used). */
  let handedOut: Uint8Array[]
  const sdk = {
    identities: {
      fetch: async () => ({ balance: 10n ** 11n, publicKeys: keys, getPublicKeyById: () => ({}) }),
      keysRemainingBudgets: async (_id: string, ids: number[]) => new Map(ids.map((i) => [i, keys.find((k) => k.keyId === i)?.totalBudget ?? null])),
      nonce: async () => 1n,
    },
  } as unknown as EvoSDK
  const controllers: (() => void)[] = []
  const make = (): AuthController => {
    const c = new AuthController(async () => sdk, NET, {
      port: () => port,
      adapter: () => ({
        ...adapter,
        get: async (o) => {
          const a: PasskeyAssertion = await adapter.get(o)
          handedOut.push(a.prfOutput)
          return a
        },
      }),
      location: () => ({ hostname: 'forge.dashhq.org', pathname: '/' }),
      available: () => true,
    })
    controllers.push(c.attach())
    return c
  }
  const signIn = async (k: FakeKey, c = make()): Promise<AuthController> => {
    await c.adoptWalletKeys(ID, [grantOf(k)], PASSKEY, { origin: 'app-connect' })
    return c
  }
  /** A new device: nothing of the identity kept in this browser (the passkey syncs with its provider). */
  const newDevice = async (c: AuthController): Promise<AuthController> => {
    await c.forget(ID)
    releaseUnlocked()
    return make()
  }
  /** An entry sealed to a passkey of the owner, as anyone with a live key of the owner could write it. */
  const plant = async (slotKeys: { keyId: number; n?: number; purpose?: number; level?: number }[]) => {
    const created = await adapter.create({ rpId: 'forge.dashhq.org', rpName: 'x', userHandle: userHandleFor(OWNER, META), userName: 'x', prfInput: PRF_INPUT, exclude: [] })
    const recipientKey = recipientFromPrf(adapter.prfOf(created.credentialId, PRF_INPUT)).publicKey
    const bundle = {
      format: FORGE_BUNDLE_FORMAT,
      keys: slotKeys.map((s) => ({ purpose: s.purpose ?? 0, securityLevel: s.level ?? 2, keyType: 0, keyId: s.keyId, privateKey: sk(s.n ?? s.keyId) })),
    }
    port.plant(OWNER, sealEntry(FORGE_VAULT_PROFILE, { contractId: META, ownerId: OWNER, credentialId: created.credentialId, recipientKey, bundle, codec: FORGE_BUNDLE_CODEC }))
    adapter.choose(created.credentialId)
    return created.credentialId
  }

  beforeEach(() => {
    resetMemoryStores()
    vi.stubGlobal('window', fakeWindow())
    releaseUnlocked()
    keys = [{ ...groupKey(1), keyId: 0, securityLevelNumber: 0, contractBounds: undefined, totalBudget: undefined, expiresAt: undefined }, groupKey(5)]
    port = new ChainPort(() => keys)
    adapter = fakePasskeyAdapter({ multiDevice: true })
    handedOut = []
    adopted.length = 0
    disabled.length = 0
  })
  afterEach(() => {
    for (const off of controllers.splice(0)) off()
    vi.unstubAllGlobals()
  })

  it('adds a passkey, then signs a new device in with it, kept under the same passkey', async () => {
    const c = await signIn(keys[1]!)
    expect(c.platformPasskeyProblem()).toBeNull()
    await c.addPlatformPasskey()
    expect(adapter.calls.create).toHaveLength(1)
    // Made, then confirmed with a prompt limited to it.
    expect(adapter.calls.get.map((g) => g.allow.length)).toEqual([1])
    expect(port.entries).toHaveLength(1)
    const entry = port.entries[0]!
    expect(entry.authKeyId).toBe(5)
    expect(await readPending(NET, ID)).toBeNull()
    expect(await readMarkers(NET, ID)).toEqual([expect.objectContaining({ credentialId: entry.credentialId, recipientKey: entry.recipientKey, keyIds: [5] })])
    const rows = await c.listPlatformPasskeys()
    expect(rows).toEqual([expect.objectContaining({ id: credentialName(entry.credentialId), thisDevice: true, keyId: 5, keyState: 'live', current: true, needsUpdate: false, encryptionKey: false })])

    const next = await newDevice(c)
    expect(await readMarkers(NET, ID)).toEqual([])
    const session = await next.signInWithPasskey()
    expect(session).toMatchObject({ identityId: ID, keyId: 5, storage: 'vault' })
    // One discoverable prompt.
    expect(adapter.calls.get.at(-1)?.allow).toEqual([])
    // The browser vault is protected by that same passkey, its PRF input the salt.
    const record = await idbGet<{ slots: { kind: string; credentialId: Uint8Array; prfSalt: Uint8Array }[] }>('vault', `vault:${NET}:${ID}`)
    expect(record?.slots).toEqual([expect.objectContaining({ kind: 'passkey', credentialId: entry.credentialId, prfSalt: PRF_INPUT })])
    expect(next.writeAuth!.getSigningKeyWif(FORGE.core)).toBe(wifOf(5))
    // The PRF outputs were wiped once used.
    expect(handedOut.length).toBeGreaterThan(0)
    for (const out of handedOut) expect(out.every((b) => b === 0)).toBe(true)
    // This device's now.
    expect((await readMarkers(NET, ID)).map((m) => credentialName(m.credentialId))).toEqual([credentialName(entry.credentialId)])
    // Again, over the key it now keeps: unlock instead.
    await expect(next.signInWithPasskey()).rejects.toMatchObject({ code: 'held', message: expect.stringMatching(/Unlock it instead/) })
  }, 30_000)

  it('keeps the encryption key in the passkey only when asked, and hands it to the browser vault', async () => {
    keys.push({ ...groupKey(9), purposeNumber: 1, securityLevelNumber: 3, contractBounds: undefined, totalBudget: undefined, expiresAt: undefined })
    const c = await signIn(keys[1]!)
    await storeEncryptionKey(NET, ID, 9, sk(9))
    await c.addPlatformPasskey({ includeEncryptionKey: true })
    expect((await readMarkers(NET, ID))[0]).toMatchObject({ keyIds: [5, 9], encryptionKeyId: 9 })
    const next = await newDevice(c)
    await next.signInWithPasskey()
    expect(adopted).toEqual([sk(9)])
  }, 30_000)

  it('refuses an encryption key this browser does not hold, before any prompt', async () => {
    keys.push({ ...groupKey(9), purposeNumber: 1, securityLevelNumber: 3, contractBounds: undefined, totalBudget: undefined, expiresAt: undefined })
    const c = await signIn(keys[1]!)
    await expect(c.addPlatformPasskey({ includeEncryptionKey: true })).rejects.toMatchObject({ code: 'ineligible' })
    expect(adapter.calls.create).toHaveLength(0)
  }, 30_000)

  it('refuses a key with no limits before any prompt', async () => {
    keys[1] = { ...keys[1]!, contractBounds: { toJSON: () => ({ $type: 'singleContract', id: FORGE.core }) }, totalBudget: undefined, expiresAt: undefined }
    const c = make()
    await c.adoptWalletKeys(ID, [{ ...grantOf(keys[1]), limits: null }], PASSKEY)
    await expect(c.addPlatformPasskey()).rejects.toMatchObject({ code: 'ineligible', message: expect.stringMatching(/no spending limit/) })
    expect(adapter.calls.create).toHaveLength(0)
  }, 30_000)

  it('keeps a passkey whose confirm was closed for "Check again", and drops one with no PRF', async () => {
    const c = await signIn(keys[1]!)
    let failGets = 1
    const real = adapter
    adapter = { ...real, get: async (o) => (failGets-- > 0 ? Promise.reject(new PasskeyError('closed', 'cancelled')) : real.get(o)) }
    await expect(c.addPlatformPasskey()).rejects.toMatchObject({ code: 'cancelled' })
    const pending = await c.pendingPlatformPasskey()
    expect(pending).not.toBeNull()
    expect(port.entries).toHaveLength(0)
    await c.finishPlatformPasskey()
    expect(port.entries.map((e) => credentialName(e.credentialId))).toEqual([pending!.id])
    expect(await c.pendingPlatformPasskey()).toBeNull()

    adapter = fakePasskeyAdapter({ prf: false })
    await expect(c.addPlatformPasskey()).rejects.toMatchObject({ code: 'no-prf' })
    expect(await c.pendingPlatformPasskey()).toBeNull()
    expect(adapter.signalled).toHaveLength(1)
  }, 30_000)

  it('stops at 10 passkeys', async () => {
    const c = await signIn(keys[1]!)
    for (let i = 0; i < 10; i++) await plant([{ keyId: 5 }])
    const before = adapter.calls.create.length
    await expect(c.addPlatformPasskey()).rejects.toMatchObject({ code: 'too-many' })
    expect(adapter.calls.create).toHaveLength(before)
  }, 30_000)

  it('says a browser-only passkey only unlocks the browser that made it', async () => {
    const c = make()
    await plant([{ keyId: 5 }])
    adapter.overrideNextHandle(new Uint8Array(32).fill(3))
    await expect(c.signInWithPasskey()).rejects.toMatchObject({ code: 'not-vault', message: expect.stringMatching(/only unlocks the browser that made it/) })
    expect(c.getState().error).toMatch(/only unlocks the browser that made it/)
    expect(await listVaults(NET)).toEqual([])
  })

  it('refuses a planted entry whose key is disabled, and stores nothing', async () => {
    keys[1] = { ...keys[1]!, disabledAt: 1n }
    const c = make()
    await plant([{ keyId: 5 }])
    await expect(c.signInWithPasskey()).rejects.toMatchObject({ code: 'refused', message: expect.stringMatching(/was disabled/) })
    expect(await listVaults(NET)).toEqual([])
    for (const out of handedOut) expect(out.every((b) => b === 0)).toBe(true)
  })

  it('after a renewal re-seals only this device’s own entries, still sealed to its recipient key', async () => {
    const c = await signIn(keys[1]!)
    await c.addPlatformPasskey()
    await c.addPlatformPasskey()
    const [mine, replaced] = port.entries.map((e) => e.credentialId)
    // Another device's passkey, and one of this device's whose entry was since replaced by one
    // sealed to someone else's key (deleted and planted again under the same credential id).
    const other = await plant([{ keyId: 5 }])
    port.entries.find((e) => credentialName(e.credentialId) === credentialName(replaced!))!.recipientKey = recipientFromPrf(sk(77)).publicKey
    port.writes.length = 0

    keys.push(groupKey(20))
    await c.importIdentity({ fileText: '{}' }, PASSKEY, undefined, { renew: true })
    await vi.waitFor(() => expect(port.writes).toEqual([{ op: 'replace', credentialId: mine }]), WAIT)
    const byId = (id: Uint8Array) => port.entries.find((e) => credentialName(e.credentialId) === credentialName(id))!
    expect(byId(mine!).authKeyId).toBe(20)
    expect(byId(replaced!).authKeyId).toBe(5)
    expect(byId(other).authKeyId).toBe(5)
    expect((await readMarkers(NET, ID)).find((m) => credentialName(m.credentialId) === credentialName(mine!))?.keyIds).toEqual([20])
    // The others need an update: one prompt each, limited to that passkey.
    expect(await c.resealPlatformPasskeys()).toEqual({ resealed: 0, needUpdate: 2 })
    const rows = await c.listPlatformPasskeys()
    expect(rows.filter((r) => r.needsUpdate).map((r) => r.id).sort()).toEqual([credentialName(replaced!), credentialName(other)].sort())
    expect(await c.resealPlatformPasskeys({ id: credentialName(other) })).toEqual({ resealed: 1, needUpdate: 0 })
    expect(adapter.calls.get.at(-1)?.allow.map(credentialName)).toEqual([credentialName(other)])
    expect(byId(other).authKeyId).toBe(20)
    // A passkey that does not give the entry's key is refused (the replaced one).
    await expect(c.resealPlatformPasskeys({ id: credentialName(replaced!) })).rejects.toMatchObject({ code: 'refused' })
  }, 60_000)

  it('removes a passkey, telling the provider only about this device’s', async () => {
    const c = await signIn(keys[1]!)
    await c.addPlatformPasskey()
    const mine = port.entries[0]!.credentialId
    const other = await plant([{ keyId: 5 }])
    await c.removePlatformPasskey(credentialName(other))
    expect(adapter.signalled).toEqual([])
    await c.removePlatformPasskey(credentialName(mine))
    expect(adapter.signalled.map(credentialName)).toEqual([credentialName(mine)])
    expect(port.entries).toEqual([])
    expect(await readMarkers(NET, ID)).toEqual([])
  }, 30_000)

  it('can delete the passkeys holding a key before that key is disabled', async () => {
    keys.push(groupKey(6))
    const c = await signIn(keys[1]!)
    await plant([{ keyId: 6 }])
    await plant([{ keyId: 5 }])
    await c.disableIdentityKey({ fileText: '{}' }, 6, { removePasskeys: true })
    expect(disabled).toEqual([[6]])
    expect(port.entries.map((e) => e.authKeyId)).toEqual([5])
  }, 30_000)

  it('keeps a passkey whose confirm the browser reports closed (a real NotAllowedError) for "Check again"', async () => {
    const c = await signIn(keys[1]!)
    let failGets = 1
    const real = adapter
    adapter = { ...real, get: async (o) => (failGets-- > 0 ? Promise.reject(vaultPasskeyFailure(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'), 'get')) : real.get(o)) }
    await expect(c.addPlatformPasskey()).rejects.toMatchObject({ code: 'cancelled', message: expect.not.stringMatching(/w3\.org|not allowed/) })
    expect(await c.pendingPlatformPasskey()).not.toBeNull()
    expect(real.signalled).toEqual([])
    // A second add waits for this one.
    await expect(c.addPlatformPasskey()).rejects.toMatchObject({ code: 'pending' })
  }, 30_000)

  it('deletes an entry whose answer was lost before discarding its passkey, and never orphans one', async () => {
    const c = await signIn(keys[1]!)
    port.loseNextAnswer = true
    await expect(c.addPlatformPasskey()).rejects.toMatchObject({ code: 'pending' })
    expect(port.entries).toHaveLength(1)
    expect(await c.pendingPlatformPasskey()).not.toBeNull()
    await c.abandonPlatformPasskey()
    expect(port.entries).toEqual([])
    expect(adapter.signalled).toHaveLength(1)
    expect(await c.pendingPlatformPasskey()).toBeNull()

    // "Check again" over an entry that did land: re-sealed and marked, nothing dropped.
    port.loseNextAnswer = true
    await expect(c.addPlatformPasskey()).rejects.toMatchObject({ code: 'pending' })
    await c.finishPlatformPasskey()
    expect(port.entries).toHaveLength(1)
    expect(await readMarkers(NET, ID)).toHaveLength(1)
    expect(adapter.signalled).toHaveLength(1)
  }, 30_000)

  it('refuses an entry replaced under a passkey’s credential id (sealed to another key)', async () => {
    const c = await signIn(keys[1]!)
    await c.addPlatformPasskey()
    port.entries[0]!.recipientKey = recipientFromPrf(sk(77)).publicKey
    const next = await newDevice(c)
    await expect(next.signInWithPasskey()).rejects.toMatchObject({ code: 'refused' })
    expect(await listVaults(NET)).toEqual([])
  }, 30_000)

  it('writes no marker back after forgetting, even with a re-seal in flight', async () => {
    const c = await signIn(keys[1]!)
    await c.addPlatformPasskey()
    keys.push(groupKey(20))
    await c.importIdentity({ fileText: '{}' }, PASSKEY, undefined, { renew: true })
    await c.forget(ID)
    expect(await readMarkers(NET, ID)).toEqual([])
  }, 30_000)

  it('is not offered on another host', () => {
    const c = new AuthController(async () => sdk, NET, { port: () => port, adapter: () => adapter, location: () => ({ hostname: 'evil.dashhq.org', pathname: '/' }), available: () => true })
    expect(c.platformPasskeyProblem()).toMatch(/Forge’s own address/)
    return expect(c.signInWithPasskey()).rejects.toMatchObject({ code: 'unavailable' })
  })
})
