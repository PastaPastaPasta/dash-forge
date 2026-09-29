/**
 * The kept session (G1, L-04), scoped: a reload keeps ONLY the limited signing key, until 12 h
 * after the unlock or 4 h idle, and every lock wipes it. A "reload" here is `releaseUnlocked()`
 * (the page's memory is gone, IndexedDB and localStorage stay); the browser is a fake window
 * over a real in-memory localStorage, and IndexedDB is the in-memory store (structured clone).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS } from '../constants'
import { idbEntries, idbGet, idbPut, resetMemoryStores } from '../idb'
import {
  AUTO_LOCK_MS,
  applyOtherTabEvent,
  forgetVault,
  holdForSession,
  keepUnlocked,
  lockVault,
  onVaultLock,
  releaseUnlocked,
  resumeVault,
  setAskToUnlockEveryVisit,
  stageInVault,
  storeEncryptionKey,
  storeInVault,
  unlockScope,
  unlockedSecret,
  withEncryptionKey,
  writeStorageBlob,
  readStorageBlob,
} from './vault'
import { KEPT_IDLE_MS, LOCKED_AT_KEY, SAVED_AT_KEY, openResume, type ResumeRecord } from './session-resume'
import { AuthController, KeyNotUsableError, UnlockNeededError } from './controller'
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
vi.mock('../view/retry', () => ({ retryWhileMissing: async <T,>(read: () => Promise<T | null>) => read() }))
vi.mock('./wif', async (orig) => {
  const real = await orig<typeof import('./wif')>()
  return { ...real, controlsKey: (k: FakeKey, wif: string) => k.wif === wif }
})
// An identity file for ID (its parsing is not what these tests check).
vi.mock('./identity-file', async (orig) => {
  const real = await orig<typeof import('./identity-file')>()
  return { ...real, masterMaterialFromFile: () => ({ identityId: '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD', networkKey: 'devnet-moutai', masterWif: 'MASTER', mnemonic: null }) }
})
vi.mock('./limited-key', async (orig) => ({
  ...(await orig<typeof import('./limited-key')>()),
  readKeyLimits: async () => ({ remaining: 5n, total: 5n, expiresAt: Date.now() + 1e9 }),
}))

interface FakeKey {
  keyId: number
  wif: string
  disabledAt?: bigint
  expiresAt?: bigint
  totalBudget?: bigint
  contractBounds?: { toJSON(): { $type: string; id: string } }
}

const NET = 'devnet' as const
const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const WIF = encodeWif(new Uint8Array(32).fill(7), NET)
const WIF2 = encodeWif(new Uint8Array(32).fill(8), NET)
const SECRET = { identityId: ID, keyId: 5, wif: WIF }
/** A passkey protection (no Argon2: fast). The fake `navigator.credentials` returns this PRF. */
const PRF = new Uint8Array(32).fill(9)
const PASSKEY = { passkey: { credentialId: new Uint8Array([1]), prfSalt: new Uint8Array(32), output: PRF } }
const SESSION_KEY = `session:${NET}`
const ENC_SECRET = new Uint8Array(32).fill(0x42)
const FORGE = NETWORKS[NET].v2!

/** A browser window: one origin's localStorage, not framed, with a fake WebAuthn for the PRF. */
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
      // The test passkey (credential id [1]); PRF returns the same output for every salt asked.
      get: async () => ({
        rawId: new Uint8Array([1]).buffer,
        getClientExtensionResults: () => ({ prf: { results: { first: PRF.slice().buffer, second: PRF.slice().buffer } } }),
      }),
    },
  }
}

const kept = (): Promise<ResumeRecord | undefined> => idbGet<ResumeRecord>('vault', SESSION_KEY)

/** Store, keep (a limited key), and drop the page's memory: what a reload leaves behind. */
async function unlockKeepAndReload(): Promise<void> {
  await storeInVault(NET, SECRET, PASSKEY)
  await keepUnlocked(NET, ID, true, { note: 'hint' })
  releaseUnlocked()
}

beforeEach(() => {
  resetMemoryStores()
  vi.stubGlobal('window', fakeWindow())
  vi.stubGlobal('navigator', fakeNavigator())
  releaseUnlocked()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('what is kept: the signing key only', () => {
  it('survives a reload with scope "signing": the limited key signs without a prompt', async () => {
    await unlockKeepAndReload()
    expect(unlockedSecret(NET, ID)).toBeNull()
    const resumed = await resumeVault(NET)
    expect(resumed?.secret).toEqual(SECRET)
    expect(resumed?.hint).toEqual({ note: 'hint' })
    expect(unlockedSecret(NET, ID)?.wif).toBe(WIF)
    expect(unlockScope(NET, ID)).toBe('signing')
  }, 30_000)

  it('never keeps the encryption key, storage settings or wallet grants (asserted on IndexedDB)', async () => {
    const extra = [{ contractId: FORGE.collab, keyId: 9, wif: WIF2 }]
    await storeInVault(NET, { ...SECRET, extra }, PASSKEY)
    await storeEncryptionKey(NET, ID, 4, new Uint8Array(ENC_SECRET))
    await writeStorageBlob(NET, ID, { bucket: 'secret-bucket-key' })
    await keepUnlocked(NET, ID, true, { note: 'hint' })
    const rec = await kept()
    expect(rec).toBeDefined()
    // The record: one sealed WIF, bound to key 5. Nothing else of the vault is in it.
    expect(rec!.keyId).toBe(5)
    const dump = JSON.stringify(rec, (_k, v: unknown) => (v instanceof Uint8Array ? bytesToHex(v) : v))
    for (const needle of [WIF, WIF2, bytesToHex(ENC_SECRET), 'secret-bucket-key', bytesToHex(new Uint8Array(32).fill(7))]) expect(dump).not.toContain(needle)
    const opened = await openResume(rec!)
    expect(opened).toEqual({ identityId: ID, keyId: 5, wif: WIF })
    // Nothing else stored in the clear either, in any vault row.
    const rows = JSON.stringify(await idbEntries('vault'), (_k, v: unknown) => (v instanceof Uint8Array ? bytesToHex(v) : v))
    for (const needle of [WIF, WIF2, bytesToHex(ENC_SECRET), 'secret-bucket-key']) expect(rows).not.toContain(needle)
  }, 30_000)

  it('after a reload, the encryption key and storage settings ask for an unlock; wallet grants are gone', async () => {
    const extra = [{ contractId: FORGE.collab, keyId: 9, wif: WIF2 }]
    await storeInVault(NET, { ...SECRET, extra }, PASSKEY)
    await storeEncryptionKey(NET, ID, 4, new Uint8Array(ENC_SECRET))
    await writeStorageBlob(NET, ID, { bucket: 'b' })
    await keepUnlocked(NET, ID, true, null)
    releaseUnlocked()
    const resumed = await resumeVault(NET)
    expect(resumed?.secret.extra).toBeUndefined()
    await expect(withEncryptionKey(NET, ID, async () => 'x')).rejects.toThrow(/unlock to use your encryption key/)
    await expect(readStorageBlob(NET, ID)).rejects.toThrow(/unlock/)
  }, 30_000)

  it('an unlimited key (no budget or expiry) is never kept', async () => {
    await storeInVault(NET, SECRET, PASSKEY)
    await keepUnlocked(NET, ID, false, null)
    expect(await kept()).toBeUndefined()
  }, 30_000)

  it('a pasted raw key is never kept', async () => {
    holdForSession(NET, { identityId: ID, keyId: -1, wif: WIF })
    await keepUnlocked(NET, ID, true, null)
    expect(await kept()).toBeUndefined()
  })

  it('a copy edited on disk (expiry, identity, key id) does not open', async () => {
    await storeInVault(NET, SECRET, PASSKEY)
    await keepUnlocked(NET, ID, true, null)
    const rec = (await kept())!
    expect(await openResume({ ...rec, expiresAt: rec.expiresAt + 1 })).toBeNull()
    expect(await openResume({ ...rec, identityId: 'someone-else' })).toBeNull()
    expect(await openResume({ ...rec, keyId: 6 })).toBeNull()
  }, 30_000)
})

describe('how long it lasts', () => {
  it('locks at the ORIGINAL 12 hours, however many reloads', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    await unlockKeepAndReload()
    for (const h of [3, 6, 9]) {
      vi.setSystemTime(start + h * 3600_000)
      releaseUnlocked()
      expect((await resumeVault(NET))?.secret.wif).toBe(WIF)
    }
    vi.setSystemTime(start + AUTO_LOCK_MS + 1)
    expect(unlockedSecret(NET, ID)).toBeNull()
    releaseUnlocked()
    expect(await resumeVault(NET)).toBeNull()
    expect(await kept()).toBeUndefined()
  }, 30_000)

  it('4 hours without use: not resumed, and wiped (checked before unwrapping)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    await unlockKeepAndReload()
    vi.setSystemTime(start + KEPT_IDLE_MS + 1)
    expect(await resumeVault(NET)).toBeNull()
    expect(await kept()).toBeUndefined()
  }, 30_000)
})

describe('every lock wipes it', () => {
  it('Lock: the next page load is locked', async () => {
    await storeInVault(NET, SECRET, PASSKEY)
    await keepUnlocked(NET, ID, true, null)
    lockVault()
    expect(await kept()).toBeUndefined()
    releaseUnlocked()
    expect(await resumeVault(NET)).toBeNull()
  }, 30_000)

  it('Forget (and revoke, which forgets) wipes session:*', async () => {
    await storeInVault(NET, SECRET, PASSKEY)
    await keepUnlocked(NET, ID, true, null)
    await forgetVault(NET, ID)
    expect(await kept()).toBeUndefined()
  }, 30_000)

  it('a copy that outlived its lock (the delete lost a race with a reload) is refused', async () => {
    await storeInVault(NET, SECRET, PASSKEY)
    await keepUnlocked(NET, ID, true, null)
    const rec = await kept()
    lockVault()
    await idbPut('vault', SESSION_KEY, rec)
    expect(await resumeVault(NET)).toBeNull()
    expect(await kept()).toBeUndefined()
  }, 30_000)

  it('a lock in another tab locks this one and wipes the copy', async () => {
    await storeInVault(NET, SECRET, PASSKEY)
    await keepUnlocked(NET, ID, true, null)
    const locked = vi.fn()
    const off = onVaultLock(locked)
    applyOtherTabEvent(LOCKED_AT_KEY)
    off()
    expect(locked).toHaveBeenCalledOnce()
    expect(unlockedSecret(NET, ID)).toBeNull()
    await vi.waitFor(async () => expect(await kept()).toBeUndefined())
  }, 30_000)

  it('a keep that races a lock does not survive it', async () => {
    await storeInVault(NET, SECRET, PASSKEY)
    const keeping = keepUnlocked(NET, ID, true, null)
    lockVault()
    await keeping
    expect(await kept()).toBeUndefined()
  }, 30_000)

  it('a lock marker that arrives late (another tab locked after this unlock began) refuses the keep (L1)', async () => {
    await storeInVault(NET, SECRET, PASSKEY)
    // Another tab's lock reaches localStorage before its storage event reaches this tab.
    window.localStorage.setItem(LOCKED_AT_KEY, String(Date.now() + 5))
    await keepUnlocked(NET, ID, true, null)
    expect(await kept()).toBeUndefined()
  }, 30_000)

  it('turning "Stay signed in" off mid-keep: the copy does not stay (L2)', async () => {
    await storeInVault(NET, SECRET, PASSKEY)
    const keeping = keepUnlocked(NET, ID, true, null)
    await setAskToUnlockEveryVisit(true)
    await keeping
    expect(await kept()).toBeUndefined()
    await setAskToUnlockEveryVisit(false)
  }, 30_000)

  it('without working localStorage nothing is kept (a lock could not reach other tabs) (L3)', async () => {
    await storeInVault(NET, SECRET, PASSKEY)
    const ls = window.localStorage
    ls.setItem = () => {
      throw new Error('QuotaExceeded')
    }
    await keepUnlocked(NET, ID, true, null)
    expect(await kept()).toBeUndefined()
  }, 30_000)

  it('"Stay signed in" off: nothing kept, and what was kept is wiped', async () => {
    await storeInVault(NET, SECRET, PASSKEY)
    await keepUnlocked(NET, ID, true, null)
    await setAskToUnlockEveryVisit(true)
    expect(await kept()).toBeUndefined()
    await keepUnlocked(NET, ID, true, null)
    expect(await kept()).toBeUndefined()
    await setAskToUnlockEveryVisit(false)
    await keepUnlocked(NET, ID, true, null)
    releaseUnlocked()
    expect((await resumeVault(NET))?.secret.wif).toBe(WIF)
  }, 30_000)

  it('a record renewed since does not resume the old key', async () => {
    await unlockKeepAndReload()
    await storeInVault(NET, { ...SECRET, keyId: 6, wif: WIF2 }, PASSKEY)
    releaseUnlocked()
    expect(await resumeVault(NET)).toBeNull()
    expect(await kept()).toBeUndefined()
  }, 30_000)

  it('a staged key renewal (D-016) is left to an interactive unlock', async () => {
    await unlockKeepAndReload()
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: WIF2 }, PASSKEY)
    expect(await resumeVault(NET)).toBeNull()
  }, 30_000)

  it('a framed page neither keeps nor resumes', async () => {
    await unlockKeepAndReload()
    ;(window as unknown as Record<string, unknown>).top = {}
    expect(await resumeVault(NET)).toBeNull()
  }, 30_000)
})

describe('the controller', () => {
  let keys: FakeKey[]
  let reads: 'ok' | 'fail'
  const limitedKey = (keyId: number, wif: string): FakeKey => ({
    keyId,
    wif,
    totalBudget: 5n,
    expiresAt: BigInt(Date.now() + 1e9),
    contractBounds: { toJSON: () => ({ $type: 'contractGroup', id: FORGE.group }) },
  })
  const sdk = {
    identities: {
      fetch: async () => {
        if (reads === 'fail') throw new Error('DAPI unreachable')
        return { balance: 10n ** 11n, publicKeys: keys, getPublicKeyById: () => ({}) }
      },
      keysRemainingBudgets: async () => new Map(),
    },
  } as unknown as EvoSDK
  const limits = { remaining: 5n, total: 5n, expiresAt: Date.now() + 1e9 }
  const controllers: (() => void)[] = []
  const make = (): AuthController => {
    const c = new AuthController(async () => sdk, NET)
    controllers.push(c.attach())
    return c
  }

  beforeEach(() => {
    reads = 'ok'
    keys = [limitedKey(5, WIF)]
  })
  afterEach(() => {
    for (const off of controllers.splice(0)) off()
  })

  async function signIn(): Promise<AuthController> {
    const c = make()
    await c.adoptLimitedKey(ID, { keyId: 5, wif: WIF, limits } as never, PASSKEY)
    await vi.waitFor(async () => expect(await kept()).toBeDefined())
    return c
  }

  it('after a reload a public write signs with no prompt', async () => {
    await signIn()
    releaseUnlocked()
    const next = make()
    expect(next.getState().resuming).toBe(true)
    expect(await next.resume()).toBe(true)
    expect(next.getState()).toMatchObject({ resuming: false, scope: 'signing' })
    expect(next.getState().session?.grants).toEqual({ core: true, collab: true, community: true })
    expect(next.writeAuth!.getSigningKeyWif(FORGE.collab)).toBe(WIF)
    expect(next.unlockScope()).toBe('signing')
  }, 30_000)

  it('a private repo asks to unlock once; after it this tab holds the key; a new tab asks again', async () => {
    const c = await signIn()
    await storeEncryptionKey(NET, ID, 4, new Uint8Array(ENC_SECRET))
    releaseUnlocked()
    const tab1 = make()
    await tab1.resume()
    await expect(withEncryptionKey(NET, ID, async () => 'x')).rejects.toThrow(/unlock/)
    await tab1.unlockMore('passkey') // one gesture
    expect(tab1.unlockScope()).toBe('full')
    expect(await withEncryptionKey(NET, ID, async (_k, s) => bytesToHex(s))).toBe(bytesToHex(ENC_SECRET))
    // The unlock was in memory only: a new tab (a new page) resumes signing-only again.
    releaseUnlocked()
    const tab2 = make()
    await tab2.resume()
    expect(tab2.unlockScope()).toBe('signing')
    await expect(withEncryptionKey(NET, ID, async () => 'x')).rejects.toThrow(/unlock/)
    expect(c).toBeDefined()
  }, 60_000)

  it('the interactive unlock over a resumed session keeps the ORIGINAL 12-hour lock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    await signIn()
    vi.setSystemTime(start + 2 * 3600_000)
    releaseUnlocked()
    const tab = make()
    await tab.resume()
    await tab.unlockMore('passkey')
    vi.setSystemTime(start + AUTO_LOCK_MS + 1)
    expect(unlockedSecret(NET, ID)).toBeNull()
  }, 60_000)

  it('a wallet grant in a resumed tab asks to unlock (not for a new wallet grant)', async () => {
    const c = make()
    keys = [{ ...limitedKey(5, WIF), contractBounds: { toJSON: () => ({ $type: 'singleContract', id: FORGE.core }) } }]
    await c.adoptLimitedKey(ID, { keyId: 5, wif: WIF, limits } as never, PASSKEY)
    await vi.waitFor(async () => expect(await kept()).toBeDefined())
    releaseUnlocked()
    const next = make()
    await next.resume()
    expect(() => next.writeAuth!.getSigningKeyWif(FORGE.collab)).toThrow(UnlockNeededError)
  }, 30_000)

  it('with nothing kept, a page load ends up signed out (and stops "resuming")', async () => {
    const c = make()
    expect(await c.resume()).toBe(false)
    expect(c.getState()).toMatchObject({ session: null, resuming: false })
  })

  it('"resuming" clears when IndexedDB fails', async () => {
    const idb = await import('../idb')
    const spy = vi.spyOn(idb, 'idbGet').mockRejectedValue(new Error('IndexedDB blocked'))
    const c = make()
    expect(await c.resume()).toBe(false)
    expect(c.getState().resuming).toBe(false)
    spy.mockRestore()
  })

  it('a key disabled on chain: the resumed session signs out, every tab locks, the copy is wiped', async () => {
    await signIn()
    releaseUnlocked()
    keys[0]!.disabledAt = 1n
    const next = make()
    await next.resume()
    await vi.waitFor(() => expect(next.getState().session).toBeNull())
    expect(next.getState().notice).toMatch(/no longer usable/)
    expect(await kept()).toBeUndefined()
  }, 30_000)

  it('a key revoked elsewhere while signed in: the next balance read signs out', async () => {
    const c = await signIn()
    keys[0]!.disabledAt = 1n
    await c.refreshBalance()
    expect(c.getState().session).toBeNull()
    expect(await kept()).toBeUndefined()
  }, 30_000)

  it('a lagging node that does not show the key yet does not lock anything (M1)', async () => {
    const c = await signIn()
    keys = []
    await c.refreshBalance()
    expect(c.getState().session?.identityId).toBe(ID)
    expect(await kept()).toBeDefined()
    // Nor on a reload: the background check leaves the session and the copy alone.
    releaseUnlocked()
    const next = make()
    await next.resume()
    await new Promise((r) => setTimeout(r, 20))
    expect(next.getState().session?.identityId).toBe(ID)
    expect(await kept()).toBeDefined()
    expect(new KeyNotUsableError('x', false).definite).toBe(false)
  }, 30_000)

  /**
   * Two tabs share one module here, so "tab B still on key 5 after tab A renewed to key 6" is
   * staged directly: B's controller and this page's memory hold key 5, while IndexedDB holds
   * what A's renewal wrote (the main record and the kept session on key 6); key 5 is disabled.
   */
  async function staleTabAfterRenewal(): Promise<AuthController> {
    const tabB = await signIn()
    await storeInVault(NET, { identityId: ID, keyId: 6, wif: WIF2 }, PASSKEY)
    await keepUnlocked(NET, ID, true, null)
    const mainRecord = await idbGet('vault', `vault:${NET}:${ID}`)
    const keptRecord = await kept()
    await storeInVault(NET, SECRET, PASSKEY)
    await idbPut('vault', `vault:${NET}:${ID}`, mainRecord)
    await idbPut('vault', SESSION_KEY, keptRecord)
    keys = [{ ...limitedKey(5, WIF), disabledAt: 1n }, limitedKey(6, WIF2)]
    expect(tabB.getState().session?.keyId).toBe(5)
    return tabB
  }

  it('a renewal in tab A does not get undone by a stale tab B refreshing its balance (H3)', async () => {
    const tabB = await staleTabAfterRenewal()
    const marker = window.localStorage.getItem(LOCKED_AT_KEY)
    await tabB.refreshBalance()
    // No lock anywhere: the marker did not move, the key-6 copy is still kept, and B switched.
    expect(window.localStorage.getItem(LOCKED_AT_KEY)).toBe(marker)
    expect((await kept())?.keyId).toBe(6)
    await vi.waitFor(() => expect(tabB.getState().session?.keyId).toBe(6))
  }, 60_000)

  it('a SAVED event from the renewing tab makes a stale tab switch keys (H3)', async () => {
    const tabB = await staleTabAfterRenewal()
    applyOtherTabEvent(SAVED_AT_KEY)
    await vi.waitFor(() => expect(tabB.getState().session?.keyId).toBe(6))
    expect((await kept())?.keyId).toBe(6)
  }, 60_000)

  it('addWalletGrant after a lock does not bring the session back (M4)', async () => {
    const c = await signIn()
    lockVault()
    await expect(
      c.addWalletGrant(ID, { keyId: 9, wif: WIF2, scope: { core: false, collab: true, community: true, unbounded: false }, limits: null }, FORGE.collab),
    ).rejects.toThrow()
    expect(c.getState().session).toBeNull()
  }, 30_000)

  it('a reload after a D-016 adoption resumes the adopted key', async () => {
    const c = make()
    await storeInVault(NET, SECRET, PASSKEY)
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: WIF2 }, PASSKEY)
    keys = [{ ...limitedKey(5, WIF), disabledAt: 1n }, limitedKey(6, WIF2)]
    releaseUnlocked()
    const s = await c.unlock(ID, 'passkey')
    expect(s.keyId).toBe(6)
    await vi.waitFor(async () => expect((await kept())?.keyId).toBe(6))
    releaseUnlocked()
    const next = make()
    expect(await next.resume()).toBe(true)
    expect(next.getState().session?.keyId).toBe(6)
  }, 60_000)

  it('a tampered hint (broadened scopes) is corrected by the background check', async () => {
    const c = make()
    keys = [{ ...limitedKey(5, WIF), contractBounds: { toJSON: () => ({ $type: 'singleContract', id: FORGE.core }) } }]
    await c.adoptLimitedKey(ID, { keyId: 5, wif: WIF, limits } as never, PASSKEY)
    await vi.waitFor(async () => expect(await kept()).toBeDefined())
    const rec = (await kept())!
    const hint = rec.hint as { session: { grants: unknown }; scopes: { main: unknown } }
    await idbPut('vault', SESSION_KEY, {
      ...rec,
      hint: { ...hint, session: { ...hint.session, grants: { core: true, collab: true, community: true } }, scopes: { main: { core: true, collab: true, community: true, unbounded: false }, extra: [] } },
    })
    releaseUnlocked()
    const next = make()
    await next.resume()
    await vi.waitFor(() => expect(next.getState().session?.grants).toEqual({ core: true, collab: false, community: false }))
  }, 30_000)

  it('a discarded instance (React StrictMode double construct) holds no listener', async () => {
    await signIn()
    for (const off of controllers.splice(0)) off()
    const discarded = new AuthController(async () => sdk, NET)
    const detach = discarded.attach()
    detach()
    releaseUnlocked()
    const real = make()
    applyOtherTabEvent(SAVED_AT_KEY)
    await vi.waitFor(() => expect(real.getState().session?.identityId).toBe(ID))
    expect(discarded.getState().session).toBeNull()
  }, 30_000)

  it('master-key actions in a signing-only tab ask to unlock first, then carry on', async () => {
    await signIn()
    // An unfinished renewal on this device (D-016), protected like the main key.
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: WIF2 }, PASSKEY)
    releaseUnlocked()
    // A reload with a staged renewal does not resume silently (only an interactive unlock can
    // adopt it); the key is still there to unlock. Stand in for the resumed tab directly.
    await idbPut('vault', `vault-staged:${NET}:${ID}`, undefined)
    const tab = make()
    await tab.resume()
    expect(tab.unlockScope()).toBe('signing')
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: WIF2 }, PASSKEY)
    // Discard (keeping its key), renew, revoke, a wallet grant: each asks for the full unlock.
    await expect(tab.abandonPendingRenewal(ID, 'passkey')).rejects.toBeInstanceOf(UnlockNeededError)
    await expect(tab.revokeStored(ID, { fileText: '{}' })).rejects.toBeInstanceOf(UnlockNeededError)
    await expect(
      tab.addWalletGrant(ID, { keyId: 9, wif: WIF2, scope: { core: false, collab: true, community: true, unbounded: false }, limits: null }, FORGE.collab),
    ).rejects.toBeInstanceOf(UnlockNeededError)
    expect(await tab.pendingRenewal(ID)).toMatchObject({ keyId: 6 })
    // The same one-gesture unlock the private repos use, then the action goes through.
    // Key 6 is live too: unlocking finishes the renewal, unless the user discards it. Keep 5
    // (the staged key is not on chain yet) so the unlock opens key 5 and leaves the stage.
    keys = [limitedKey(5, WIF)]
    const opened = await tab.unlockMore('passkey')
    expect(opened.keyId).toBe(5)
    expect(tab.unlockScope()).toBe('full')
    await tab.abandonPendingRenewal(ID, 'passkey')
    expect(await tab.pendingRenewal(ID)).toBeNull()
  }, 60_000)

  it('a signing-only tab still finishes a staged renewal on its interactive unlock (D-016)', async () => {
    await signIn()
    await idbPut('vault', `vault-staged:${NET}:${ID}`, undefined)
    releaseUnlocked()
    const tab = make()
    await tab.resume()
    expect(tab.unlockScope()).toBe('signing')
    // Another tab staged and registered key 6, then died before committing it.
    await stageInVault(NET, { identityId: ID, keyId: 6, wif: WIF2 }, PASSKEY)
    keys = [{ ...limitedKey(5, WIF), disabledAt: 1n }, limitedKey(6, WIF2)]
    const s = await tab.unlockMore('passkey')
    expect(s.keyId).toBe(6)
    expect(await tab.pendingRenewal(ID)).toBeNull()
    await vi.waitFor(async () => expect((await kept())?.keyId).toBe(6))
  }, 60_000)

  it('a signing-only tab: renew and revoke touch nothing (grants, storage, encryption blobs stay)', async () => {
    await signIn()
    await storeEncryptionKey(NET, ID, 4, new Uint8Array(ENC_SECRET))
    await writeStorageBlob(NET, ID, { bucket: 'b' })
    // The vault rows other than the kept session (whose usedAt a resume touches).
    const vaultRows = async (): Promise<string> =>
      JSON.stringify(
        (await idbEntries('vault')).filter(([k]) => k !== SESSION_KEY),
        (_k, v: unknown) => (v instanceof Uint8Array ? bytesToHex(v) : typeof v === 'bigint' ? v.toString() : v),
      )
    const before = await vaultRows()
    releaseUnlocked()
    const tab = make()
    await tab.resume()
    await expect(tab.revokeStored(ID, { fileText: '{}' })).rejects.toBeInstanceOf(UnlockNeededError)
    await expect(tab.importIdentity({ fileText: '{}' }, PASSKEY, undefined, { renew: true })).rejects.toBeInstanceOf(UnlockNeededError)
    // A new encryption key would only live in this tab: refused.
    await expect(storeEncryptionKey(NET, ID, 4, new Uint8Array(ENC_SECRET))).rejects.toThrow(/unlock this tab/)
    expect(await vaultRows()).toBe(before)
  }, 60_000)

  it('an unbounded key (no contract bounds) is never kept', async () => {
    const c = make()
    keys = [{ ...limitedKey(5, WIF), contractBounds: undefined }]
    await c.adoptLimitedKey(ID, { keyId: 5, wif: WIF, limits } as never, PASSKEY)
    await new Promise((r) => setTimeout(r, 50))
    expect(await kept()).toBeUndefined()
  }, 30_000)

  it('a failed sign-in read drops the key in this tab only (the kept session stays)', async () => {
    await signIn()
    const c = make()
    c.abandonSignIn()
    expect(unlockedSecret(NET, ID)).toBeNull()
    expect(await kept()).toBeDefined()
    reads = 'ok'
  }, 30_000)
})
