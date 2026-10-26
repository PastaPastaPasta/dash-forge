/**
 * A session on a key a wallet granted through App Connect v2: one group-bound key covering every
 * Forge contract, kept across reloads, with its origin stored beside it; no new write in its last
 * five minutes; renewed in the wallet without locking anything while the wallet swaps the key;
 * and a master-key renewal that makes it an ordinary Forge key again. The chain is a fake; the
 * vault is the real one (in-memory IndexedDB, a fake window's localStorage). The vault's unlock is
 * one per page, so these tests are one tab: what another tab does in the same moment is the same
 * code path (`superseded`, `supersede`) reached from its own refresh or kept-session event.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS } from '../constants'
import { forgeContractIds } from '../deployments'
import { idbGet, resetMemoryStores } from '../idb'
import { KeyUnusableError } from '../sdk/write'
import { AuthController } from './controller'
import { walletRenewalInFlight } from './connection-id'
import type { WalletKey } from './key-registration'
import { LOCKED_AT_KEY } from './session-resume'
import { hasExtraKeys, listVaults, lockVault, readStorageBlob, releaseUnlocked, writeStorageBlob } from './vault'
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
  const devnet = { ...real.NETWORKS.devnet, key: 'devnet-moutai', v2: forgeV2Ids(DEPLOYMENTS['devnet-moutai']) }
  return { ...real, NETWORKS: { ...real.NETWORKS, devnet } }
})
// The group check before a renewal's code (its reads are `group-trust.test.ts`'s).
vi.mock('./group-trust', async (orig) => ({ ...(await orig<typeof import('./group-trust')>()), assertGroupHolds: async () => ({ unknown: [], unchecked: [], notice: null }) }))
vi.mock('../view/retry', () => ({ retryWhileMissing: async <T,>(read: () => Promise<T | null>) => read() }))
vi.mock('./wif', async (orig) => {
  const real = await orig<typeof import('./wif')>()
  return { ...real, controlsKey: (k: FakeKey, wif: string) => k.wif === wif }
})
vi.mock('./identity-file', async (orig) => {
  const real = await orig<typeof import('./identity-file')>()
  return { ...real, masterMaterialFromFile: () => ({ identityId: '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD', networkKey: 'devnet-moutai', masterWif: 'MASTER', mnemonic: null }) }
})
// The master-key renewal: recorded, not sent; it registers key 20.
const registered = vi.hoisted(() => [] as unknown[])
vi.mock('./limited-key', async (orig) => {
  const real = await orig<typeof import('./limited-key')>()
  return {
    ...real,
    registerLimitedKey: async (_sdk: unknown, params: { persist?: (k: { keyId: number; wif: string }) => Promise<void> }) => {
      registered.push(params)
      const key = { keyId: 20, wif: encodeWif(new Uint8Array(32).fill(20), 'devnet') }
      await params.persist?.(key)
      return { ...key, limits: { remaining: 5n, total: 5n, expiresAt: Date.now() + 1e9 } }
    },
  }
})

interface FakeKey {
  keyId: number
  wif: string
  purposeNumber: number
  securityLevelNumber: number
  disabledAt?: bigint
  expiresAt?: bigint
  totalBudget?: bigint
  contractBounds?: { toJSON(): { $type: string; id: string } }
}

const NET = 'devnet' as const
const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const FORGE = NETWORKS[NET].v2!
const NETWORK_KEY = NETWORKS[NET].key
const wifOf = (n: number): string => encodeWif(new Uint8Array(32).fill(n), NET)
/** A passkey protection (no Argon2: fast). The fake `navigator.credentials` returns this PRF. */
const PRF = new Uint8Array(32).fill(9)
const PASSKEY = { passkey: { credentialId: new Uint8Array([1]), prfSalt: new Uint8Array(32), output: PRF } }
const WAIT = { timeout: 15_000, interval: 20 }
const MIN = 60 * 1000

function fakeWindow(): { localStorage: Storage } {
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
  } as Storage
  const win: Record<string, unknown> = {
    localStorage,
    location: { hostname: 'forge.dashhq.org', pathname: '/' },
    addEventListener: () => undefined,
    isSecureContext: true,
    PublicKeyCredential: function PublicKeyCredential() {},
  }
  win.top = win
  win.self = win
  return win as unknown as { localStorage: Storage }
}

function fakeNavigator(): unknown {
  return {
    credentials: {
      get: async () => ({
        rawId: new Uint8Array([1]).buffer,
        getClientExtensionResults: () => ({ prf: { results: { first: PRF.slice().buffer, second: PRF.slice().buffer } } }),
      }),
    },
  }
}

/** A group-bound HIGH key with a budget and `expiresAt`: what a v2 wallet registers. */
function groupKey(keyId: number, expiresAt = Date.now() + 90 * 24 * 60 * MIN): FakeKey {
  return {
    keyId,
    wif: wifOf(keyId),
    purposeNumber: 0,
    securityLevelNumber: 2,
    totalBudget: 5_000_000_000n,
    expiresAt: BigInt(expiresAt),
    contractBounds: { toJSON: () => ({ $type: 'contractGroup', id: FORGE.group }) },
  }
}

/** The verified grant `awaitV2Grant` hands back for `k`. */
function grantOf(k: FakeKey): WalletKey {
  return {
    keyId: k.keyId,
    wif: k.wif,
    scope: { core: true, collab: true, community: true, meta: true, unbounded: false },
    limits: { remaining: k.totalBudget!, total: k.totalBudget!, expiresAt: Number(k.expiresAt) },
  }
}

describe('an App Connect v2 session', () => {
  let keys: FakeKey[]
  const sdk = {
    identities: {
      fetch: async () => ({ balance: 10n ** 11n, publicKeys: keys, getPublicKeyById: () => ({}) }),
      keysRemainingBudgets: async (_id: string, ids: number[]) => new Map(ids.map((i) => [i, keys.find((k) => k.keyId === i)?.totalBudget ?? null])),
      nonce: async () => 1n,
    },
  } as unknown as EvoSDK
  const controllers: (() => void)[] = []
  const make = (): AuthController => {
    const c = new AuthController(async () => sdk, NET)
    controllers.push(c.attach())
    return c
  }
  const signIn = async (k: FakeKey, c = make()): Promise<AuthController> => {
    await c.adoptWalletKeys(ID, [grantOf(k)], PASSKEY, { origin: 'app-connect' })
    return c
  }
  const locked = (): boolean => window.localStorage.getItem(LOCKED_AT_KEY) !== null

  beforeEach(() => {
    resetMemoryStores()
    vi.stubGlobal('window', fakeWindow())
    vi.stubGlobal('navigator', fakeNavigator())
    releaseUnlocked()
    registered.length = 0
    keys = [{ keyId: 0, wif: wifOf(1), purposeNumber: 0, securityLevelNumber: 0 }, groupKey(5)]
  })
  afterEach(() => {
    for (const off of controllers.splice(0)) off()
    vi.unstubAllGlobals()
  })

  it('covers every Forge contract with one limited key, signs each, and is kept for reloads', async () => {
    const c = await signIn(keys[1]!)
    const s = c.getState().session!
    expect(s.origin).toBe('app-connect')
    expect(s.grants).toEqual({ core: true, collab: true, community: true, meta: true })
    expect(s.unlimited).toBe(false)
    expect(s.unbounded).toBe(false)
    for (const contract of forgeContractIds(FORGE)) expect(c.writeAuth!.getSigningKeyWif(contract)).toBe(wifOf(5))
    // "Stay signed in for public repos" keeps it: a budgeted, expiring, group-bound key.
    await vi.waitFor(async () => expect(await idbGet('vault', `session:${NET}`)).toBeDefined(), WAIT)
  }, 30_000)

  it('starts no write in the key’s last five minutes (renew it in the wallet), but signs before them', async () => {
    keys[1] = groupKey(5, Date.now() + 4 * MIN)
    const c = await signIn(keys[1])
    expect(() => c.writeAuth!.getSigningKeyWif(FORGE.core)).toThrow(KeyUnusableError)
    expect(() => c.writeAuth!.getSigningKeyWif(FORGE.core)).toThrow(expect.objectContaining({ reason: 'expired' }))

    keys[1] = groupKey(5, Date.now() + 6 * MIN)
    const fresh = await signIn(keys[1])
    expect(fresh.writeAuth!.getSigningKeyWif(FORGE.core)).toBe(wifOf(5))
  }, 30_000)

  it('the margin is App Connect’s: the same key from a v1 wallet still signs', async () => {
    keys[1] = groupKey(5, Date.now() + 4 * MIN)
    const c = make()
    await c.adoptWalletKeys(ID, [grantOf(keys[1])], PASSKEY)
    expect(c.getState().session?.origin).toBeUndefined()
    expect(c.writeAuth!.getSigningKeyWif(FORGE.core)).toBe(wifOf(5))
  }, 30_000)

  it('keeps its origin across a lock and unlock, and across a reload of a kept session', async () => {
    const c = await signIn(keys[1]!)
    await vi.waitFor(async () => expect(await idbGet('vault', `session:${NET}`)).toBeDefined(), WAIT)
    expect((await listVaults(NET)).find((v) => v.identityId === ID)).toMatchObject({ fromAppConnect: true })
    // A reload picks up the kept session: its origin is there before and after the chain check.
    releaseUnlocked()
    const next = make()
    expect(await next.resume()).toBe(true)
    expect(next.getState().session?.origin).toBe('app-connect')
    await vi.waitFor(() => expect(next.getState().session?.balanceReadAt).toBeTypeOf('number'), WAIT)
    expect(next.getState().session?.origin).toBe('app-connect')
    // An interactive unlock reads it from the stored record.
    c.logout()
    const unlocked = await make().unlock(ID, 'passkey')
    expect(unlocked.origin).toBe('app-connect')
  }, 60_000)

  it('a master-key renewal makes it an ordinary Forge key (origin cleared)', async () => {
    const c = await signIn(keys[1]!)
    keys.push({ ...groupKey(20), wif: wifOf(20) })
    const renewed = await c.importIdentity({ fileText: '{}' }, PASSKEY, undefined, { renew: true })
    expect(registered).toHaveLength(1)
    expect(renewed.keyId).toBe(20)
    expect(renewed.origin).toBeUndefined()
    const stored = (await listVaults(NET)).find((v) => v.identityId === ID)
    expect(stored?.keyId).toBe(20)
    expect(stored?.fromAppConnect).toBeUndefined()
  }, 30_000)

  it('renews in the wallet: the replaced key locks nothing, and the renewal carries everything over', async () => {
    const c = await signIn(keys[1]!)
    await writeStorageBlob(NET, ID, { bucket: 'kept' })
    const req = await c.walletRenewalRequest()
    expect(req).toMatchObject({ identityHint: ID, replacesKeyId: 5 })
    expect(walletRenewalInFlight(NETWORK_KEY, ID, 5)).toBe(true)
    // The wallet's update: key 5 disabled, key 6 added. A refresh now finds its key disabled: no
    // lock, and the renewing tab keeps its unlock (it stores the new key with it).
    keys[1]!.disabledAt = 1n
    keys.push(groupKey(6))
    await c.refreshBalance()
    expect(locked()).toBe(false)
    expect(c.getState().session?.keyId).toBe(5)
    const renewed = await signIn(keys[2]!, c)
    expect(renewed.getState().session).toMatchObject({ keyId: 6, origin: 'app-connect' })
    expect(walletRenewalInFlight(NETWORK_KEY, ID, 5)).toBe(false)
    expect(locked()).toBe(false)
    // Storage settings carried over; the disabled key is not held on (nothing left to disable).
    expect(await readStorageBlob(NET, ID)).toEqual({ bucket: 'kept' })
    expect(await hasExtraKeys(NET, ID)).toBe(false)
  }, 60_000)

  it('keeps a replaced key the wallet left live, so a later revoke disables it', async () => {
    const c = await signIn(keys[1]!)
    keys.push(groupKey(6))
    await signIn(keys[2]!, c)
    expect(await hasExtraKeys(NET, ID)).toBe(true)
  }, 30_000)

  it('a v2 sign-in over a locked vault is blocked only where unlocking would be needed', async () => {
    const c = await signIn(keys[1]!)
    c.logout()
    // A group-bound Forge key alone: a master-key update disables it by id, locked or not.
    expect(await c.walletSignInBlocker()).toBeNull()
    // A shipped wallet's unlimited key: unlock first, while it still opens.
    keys[1] = { ...keys[1]!, totalBudget: undefined, expiresAt: undefined, contractBounds: { toJSON: () => ({ $type: 'singleContract', id: FORGE.core }) } }
    expect(await c.walletSignInBlocker()).toMatch(/Unlock first/)
  }, 30_000)

  it('ends a renewal it gave up without touching another key’s mark', async () => {
    const c = await signIn(keys[1]!)
    const req = await c.walletRenewalRequest()
    c.endWalletRenewal({ ...req, replacesKeyId: 99 })
    expect(walletRenewalInFlight(NETWORK_KEY, ID, 5)).toBe(true)
    c.endWalletRenewal(req)
    expect(walletRenewalInFlight(NETWORK_KEY, ID, 5)).toBe(false)
  }, 30_000)

  it('without a renewal in flight, a disabled key still signs out every tab', async () => {
    const c = await signIn(keys[1]!)
    const req = await c.walletRenewalRequest()
    c.endWalletRenewal(req)
    expect(walletRenewalInFlight(NETWORK_KEY, ID, 5)).toBe(false)
    keys[1]!.disabledAt = 1n
    await c.refreshBalance()
    expect(locked()).toBe(true)
    expect(c.getState().notice).toMatch(/Signed out/)
  }, 30_000)

  it('renews in the wallet only a key a wallet granted, with the whole vault open', async () => {
    const v1 = make()
    await v1.adoptWalletKeys(ID, [grantOf(keys[1]!)], PASSKEY)
    await expect(v1.walletRenewalRequest()).rejects.toThrow(/identity file or recovery phrase/)
    lockVault()
    // A reload's signing-only tab must unlock first: storing the new key needs the whole vault.
    const c = await signIn(keys[1]!)
    await vi.waitFor(async () => expect(await idbGet('vault', `session:${NET}`)).toBeDefined(), WAIT)
    releaseUnlocked()
    const resumed = make()
    await resumed.resume()
    await expect(resumed.walletRenewalRequest()).rejects.toThrow(/Unlock this tab first/)
    expect(c).toBeDefined()
  }, 60_000)

  it('checks the session again on request (a write outside the key’s bounds)', async () => {
    const c = await signIn(keys[1]!)
    keys[1]!.totalBudget = 4_000_000_000n
    const s = await c.recheckSession()
    expect(s?.keyLimits?.remaining).toBe(4_000_000_000n)
    keys[1]!.disabledAt = 1n
    await expect(c.recheckSession()).rejects.toThrow()
    expect(locked()).toBe(true)
  }, 30_000)
})
