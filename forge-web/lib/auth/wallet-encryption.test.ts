/**
 * A wallet login keeps the encryption key its login key stands for (DESIGN D27, §4.8): sealed
 * into the vault beside the wallet key when it is the identity's usable ENCRYPTION key, at the
 * first login and at a returning one; after a reload one unlock opens it for every repo in the
 * tab; and when the identity uses another key (registered from `dg`), nothing is stored and the
 * sign-in says where to import it. The chain is a fake; the vault is the real one (in-memory
 * IndexedDB), behind a fake window whose passkey counts its prompts.
 */

import * as secp from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS } from '../constants'
import { idbEntries, resetMemoryStores } from '../idb'
import { AuthController } from './controller'
import { ENCRYPTION_KEY_ELSEWHERE, ENCRYPTION_KEY_OTHER_APPROVAL, adoptWalletEncryptionKey, encryptionKeyState, encryptionOps } from './encryption-key'
import type { WalletKey } from './key-registration'
import { lockVault, releaseUnlocked, storeEncryptionKey, storeInVault, storedEncryptionKeyId, withEncryptionKey } from './vault'
import { encryptionKeyFromLogin } from './wallet-protocol'
import { decodeWif, encodeWif } from './wif'

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
// The SDK's private key only carries its bytes here; an unwrap reports the key it was handed.
vi.mock('@dashevo/evo-sdk', () => ({
  PrivateKey: {
    fromWIF: (wif: string) => ({ toBytes: () => new TextEncoder().encode(wif), free: () => undefined }),
    fromBytes: (b: Uint8Array) => ({ hex: Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''), free: () => undefined }),
  },
  Document: { fromJSON: (j: unknown) => j },
}))
vi.mock('../private', async (orig) => ({
  ...(await orig<typeof import('../private')>()),
  unwrapKey: async (_facade: unknown, p: { readerPrivateKey: { hex: string }; repoId: Uint8Array }) => ({ reader: p.readerPrivateKey.hex, repo: bytesToHex(p.repoId) }),
}))

interface FakeKey {
  keyId: number
  wif?: string
  purposeNumber: number
  securityLevelNumber: number
  keyTypeNumber: number
  data: string
  disabledAt?: bigint
  contractBounds?: { toJSON(): { $type: string; id: string } }
  validatePrivateKey(bytes: Uint8Array): boolean
}

const NET = 'devnet' as const
const FORGE = NETWORKS[NET].v2!
const ID = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const AUTH_WIF = encodeWif(new Uint8Array(32).fill(5), NET)
/** The wallet's login key and the encryption key it stands for (what the wallet registers). */
const LOGIN = new Uint8Array(32).fill(0x11)
const WALLET_ENC = encryptionKeyFromLogin(LOGIN, ID)
/** A key registered from `dg`: not the wallet's. */
const DG_ENC = new Uint8Array(32).fill(0x33)
const pub = (priv: Uint8Array): string => bytesToHex(secp.getPublicKey(priv, true))

/** A passkey protection (no Argon2: fast). The fake `navigator.credentials` returns this PRF. */
const PRF = new Uint8Array(32).fill(9)
const PASSKEY = { passkey: { credentialId: new Uint8Array([1]), prfSalt: new Uint8Array(32), output: PRF } }
let gestures = 0

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
  const win: Record<string, unknown> = {
    localStorage,
    location: { hostname: 'forge.dashhq.org', pathname: '/' },
    addEventListener: () => undefined,
    isSecureContext: true,
    PublicKeyCredential: function PublicKeyCredential() {},
  }
  win.top = win
  win.self = win
  return win
}

const fakeNavigator = {
  credentials: {
    get: async () => {
      gestures += 1
      return {
        rawId: new Uint8Array([1]).buffer,
        getClientExtensionResults: () => ({ prf: { results: { first: PRF.slice().buffer, second: PRF.slice().buffer } } }),
      }
    },
  },
}

function authKey(keyId: number, wif: string, contract = FORGE.core): FakeKey {
  return {
    keyId,
    wif,
    purposeNumber: 0,
    securityLevelNumber: 2,
    keyTypeNumber: 2,
    data: '',
    contractBounds: { toJSON: () => ({ $type: 'singleContract', id: contract }) },
    validatePrivateKey: (bytes) => bytesToHex(bytes) === bytesToHex(decodeWif(wif).privateKey),
  }
}

function encKey(keyId: number, priv: Uint8Array, extra: Partial<FakeKey> = {}): FakeKey {
  return { keyId, purposeNumber: 1, securityLevelNumber: 2, keyTypeNumber: 0, data: pub(priv), validatePrivateKey: () => false, ...extra }
}

describe('wallet login and the encryption key (D27)', () => {
  let keys: FakeKey[]
  const sdk = {
    identities: {
      fetch: async () => ({ balance: 10n ** 11n, publicKeys: keys, getPublicKeyById: () => ({}) }),
      keysRemainingBudgets: async () => new Map(),
    },
    contracts: { fetch: async () => ({}) },
    version: () => 10,
    encryptedFor: {},
  } as unknown as EvoSDK
  const walletKey: WalletKey = { keyId: 5, wif: AUTH_WIF, scope: { core: true, collab: false, community: false, unbounded: false }, limits: null }
  const detach: (() => void)[] = []
  const make = (): AuthController => {
    const c = new AuthController(async () => sdk, NET)
    detach.push(c.attach())
    return c
  }
  /** What the sign-in sheet hands over: the wallet's encryption key (a copy it wipes itself). */
  const login = (c: AuthController, justRegistered = false) =>
    c.adoptWalletKeys(ID, [walletKey], PASSKEY, { encryptionKeys: [new Uint8Array(WALLET_ENC)], justRegistered })

  beforeEach(() => {
    resetMemoryStores()
    vi.stubGlobal('window', fakeWindow())
    vi.stubGlobal('navigator', fakeNavigator)
    lockVault()
    gestures = 0
    // The first wallet login's update: the auth key, and the encryption key right after it.
    keys = [authKey(5, AUTH_WIF), encKey(6, WALLET_ENC)]
  })
  afterEach(() => {
    for (const off of detach.splice(0)) off()
    vi.unstubAllGlobals()
  })

  it('a first login seals the key whose public key is the identity ENCRYPTION key, never in plaintext', async () => {
    const c = make()
    await login(c, true)
    expect(c.getState().notice ?? null).toBeNull()
    expect(await storedEncryptionKeyId(NET, ID)).toBe(6)
    const held = await withEncryptionKey(NET, ID, async (keyId, secret) => ({ keyId, pub: pub(secret) }))
    expect(held).toEqual({ keyId: 6, pub: keys.find((k) => k.keyId === 6)!.data })
    const dump = JSON.stringify(await idbEntries('vault'), (_k, v: unknown) => (v instanceof Uint8Array ? bytesToHex(v) : v))
    expect(dump).not.toContain(bytesToHex(WALLET_ENC))
  }, 30_000)

  it('a returning login (another browser) re-derives and stores the same key', async () => {
    await login(make())
    resetMemoryStores()
    lockVault()
    await login(make())
    expect(await storedEncryptionKeyId(NET, ID)).toBe(6)
    expect(await withEncryptionKey(NET, ID, async (_k, s) => bytesToHex(s))).toBe(bytesToHex(WALLET_ENC))
  }, 30_000)

  it('over a locked vault whose copy cannot be carried over, the wallet key replaces it without a "not carried over" notice', async () => {
    // An earlier sign-in with a limited key from the identity file, its encryption key beside it.
    await storeInVault(NET, { identityId: ID, keyId: 9, wif: encodeWif(new Uint8Array(32).fill(9), NET) }, PASSKEY)
    await storeEncryptionKey(NET, ID, 6, new Uint8Array(WALLET_ENC))
    lockVault()
    const c = make()
    await login(c)
    expect(c.getState().notice ?? null).toBeNull()
    expect(await withEncryptionKey(NET, ID, async (k, s) => [k, bytesToHex(s)])).toEqual([6, bytesToHex(WALLET_ENC)])
  }, 30_000)

  it('after a reload the key is locked; one unlock opens it for two different repos', async () => {
    await login(make())
    releaseUnlocked() // a reload: the page's memory is gone
    const tab = make()
    // A wallet key has no budget or expiry, so it is never kept: nothing resumes.
    expect(await tab.resume()).toBe(false)
    expect(await encryptionKeyState(NET, ID)).toBe('locked')
    await expect(withEncryptionKey(NET, ID, async () => 1)).rejects.toThrow(/unlock/)
    await tab.unlock(ID, 'passkey')
    expect(gestures).toBe(1)
    expect(await encryptionKeyState(NET, ID)).toBe('open')
    const ops = await encryptionOps(sdk, NET, ID, FORGE.collab)
    expect(ops?.keyId).toBe(6)
    const read = (repo: number) =>
      ops!.unwrap({ document: {}, counterpartyKey: {} as never, repoId: new Uint8Array(32).fill(repo), epoch: 0 }) as unknown as Promise<{ reader: string; repo: string }>
    const a = await read(0xa1)
    const b = await read(0xb2)
    expect([a.reader, b.reader]).toEqual([bytesToHex(WALLET_ENC), bytesToHex(WALLET_ENC)])
    expect(a.repo).not.toBe(b.repo)
    // Both repos read with the one gesture.
    expect(gestures).toBe(1)
  }, 30_000)

  it('the identity uses a key from dg: says where to import it, and stores nothing', async () => {
    keys = [authKey(5, AUTH_WIF), encKey(7, DG_ENC)]
    const c = make()
    await login(c)
    expect(c.getState().notice).toBe(ENCRYPTION_KEY_ELSEWHERE)
    expect(ENCRYPTION_KEY_ELSEWHERE).toBe('Your encryption key is held elsewhere. Import it under Settings → Private repos.')
    expect(await storedEncryptionKeyId(NET, ID)).toBeNull()
    expect((await idbEntries('vault')).some(([k]) => String(k).includes('enc'))).toBe(false)
    // The sign-in itself went through.
    expect(c.getState().session?.identityId).toBe(ID)
  }, 30_000)

  it("the wallet's key is on the identity but a newer key from dg is the one writers use: not stored", async () => {
    keys = [authKey(5, AUTH_WIF), encKey(6, WALLET_ENC), encKey(7, DG_ENC)]
    const c = make()
    await login(c)
    expect(c.getState().notice).toBe(ENCRYPTION_KEY_ELSEWHERE)
    expect(await storedEncryptionKeyId(NET, ID)).toBeNull()
  }, 30_000)

  it('a disabled wallet key, or one bound to another contract, is not stored', async () => {
    keys = [authKey(5, AUTH_WIF), encKey(6, WALLET_ENC, { disabledAt: 1n })]
    const c = make()
    await login(c)
    expect(c.getState().notice ?? null).toBeNull()
    expect(await storedEncryptionKeyId(NET, ID)).toBeNull()
    keys = [authKey(5, AUTH_WIF), encKey(6, WALLET_ENC, { contractBounds: { toJSON: () => ({ $type: 'singleContract', id: FORGE.collab }) } })]
    resetMemoryStores()
    lockVault()
    await login(make())
    expect(await storedEncryptionKeyId(NET, ID)).toBeNull()
  }, 30_000)

  it('the vault already holds the key from dg: no notice, and it stays', async () => {
    keys = [authKey(5, AUTH_WIF), encKey(7, DG_ENC)]
    const c = make()
    await login(c)
    await storeEncryptionKey(NET, ID, 7, new Uint8Array(DG_ENC))
    c.clearNotice()
    await login(c)
    expect(c.getState().notice ?? null).toBeNull()
    expect(await withEncryptionKey(NET, ID, async (k, s) => [k, bytesToHex(s)])).toEqual([7, bytesToHex(DG_ENC)])
  }, 30_000)

  it("waits for a node a block behind the wallet's registration, and wipes only its own copies", async () => {
    keys = [authKey(5, AUTH_WIF)]
    await login(make())
    // The node shows the encryption key from its third read on.
    const behind = [authKey(5, AUTH_WIF)]
    const caughtUp = [authKey(5, AUTH_WIF), encKey(6, WALLET_ENC)]
    let reads = 0
    const lagging = {
      ...sdk,
      identities: { ...(sdk as unknown as { identities: object }).identities, fetch: async () => ({ balance: 10n ** 11n, publicKeys: ++reads >= 3 ? caughtUp : behind }) },
    } as unknown as EvoSDK
    const mine = new Uint8Array(WALLET_ENC)
    const outcome = await adoptWalletEncryptionKey(lagging, NET, ID, FORGE.core, [mine], { attempts: 5, intervalMs: 5 })
    expect(outcome).toEqual({ kind: 'stored', keyId: 6 })
    expect(reads).toBe(3)
    expect(bytesToHex(mine)).toBe(bytesToHex(WALLET_ENC))
    // Without retries (a returning login), one read decides.
    reads = 0
    expect(await adoptWalletEncryptionKey(lagging, NET, ID, FORGE.core, [mine])).toEqual({ kind: 'none' })
    expect(reads).toBe(1)
  }, 30_000)

  it('copies the key at once: the sheet wiping its bytes mid sign-in does not matter', async () => {
    const theirs = new Uint8Array(WALLET_ENC)
    const c = make()
    const signingIn = c.adoptWalletKeys(ID, [walletKey], PASSKEY, { encryptionKeys: [theirs] })
    theirs.fill(0) // the sheet closed
    await signingIn
    expect(c.getState().notice ?? null).toBeNull()
    expect(await withEncryptionKey(NET, ID, async (k, s) => [k, bytesToHex(s)])).toEqual([6, bytesToHex(WALLET_ENC)])
  }, 30_000)

  it("a grant's first approval registers the identity's new usable key: the grant keeps it", async () => {
    const c = make()
    await login(c, true)
    // The wallet's first approval for forge-collab: another auth key, and another encryption key.
    const COLLAB_WIF = encodeWif(new Uint8Array(32).fill(7), NET)
    const collabEnc = encryptionKeyFromLogin(new Uint8Array(32).fill(0x22), ID)
    keys = [...keys, authKey(7, COLLAB_WIF, FORGE.collab), encKey(8, collabEnc)]
    const grant: WalletKey = { keyId: 7, wif: COLLAB_WIF, scope: { core: false, collab: true, community: false, unbounded: false }, limits: null }
    await c.addWalletGrant(ID, grant, FORGE.collab, { encryptionKeys: [new Uint8Array(collabEnc)], justRegistered: true })
    expect(c.getState().notice ?? null).toBeNull()
    expect(await withEncryptionKey(NET, ID, async (k, s) => [k, bytesToHex(s)])).toEqual([8, bytesToHex(collabEnc)])
    // A later forge-core login elsewhere: its key is no longer the identity's, and the notice
    // points to the approval that brings it (not to an import no file could make).
    resetMemoryStores()
    lockVault()
    const other = make()
    await login(other)
    expect(other.getState().notice).toBe(ENCRYPTION_KEY_OTHER_APPROVAL)
    expect(await storedEncryptionKeyId(NET, ID)).toBeNull()
  }, 30_000)

  it('replacing a different key the vault could not carry over still says it was dropped', async () => {
    const OLD = new Uint8Array(32).fill(0x44)
    keys = [encKey(4, OLD), authKey(5, AUTH_WIF), encKey(6, WALLET_ENC)]
    await storeInVault(NET, { identityId: ID, keyId: 9, wif: encodeWif(new Uint8Array(32).fill(9), NET) }, PASSKEY)
    await storeEncryptionKey(NET, ID, 4, new Uint8Array(OLD))
    lockVault()
    const c = make()
    await login(c)
    expect(c.getState().notice).toMatch(/not carried over/)
    expect(await withEncryptionKey(NET, ID, async (k) => k)).toBe(6)
  }, 30_000)
})
