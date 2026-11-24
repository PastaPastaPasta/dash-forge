/**
 * A vault an older wallet sign-in (DashConnect, removed) left behind keeps working (DESIGN D27,
 * §4.8): its main wallet key, a grant for another contract and the encryption keys sealed beside
 * them unlock with one gesture after a reload, and a wrap to either encryption key opens. A
 * wallet sign-in now brings no encryption key, so one the vault cannot carry over is reported.
 * The chain is a fake; the vault is the real one (in-memory IndexedDB), behind a fake window whose
 * passkey counts its prompts.
 */

import * as secp from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS } from '../constants'
import { idbEntries, idbGet, idbPut, resetMemoryStores } from '../idb'
import { AuthController } from './controller'
import { ENCRYPTION_KEY_OTHER_APPROVAL, encryptionKeyState, encryptionOps, type EncryptionOps, type UnwrapInput } from './encryption-key'
import { WrapError } from '../private'
import type { WalletKey } from './wallet-key'
import { holdForSession, lockVault, releaseUnlocked, storeEncryptionKey, storeInVault, storedEncryptionKeyIds, withEncryptionKey } from './vault'
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
// A wrap opens only with the private key it was sealed to (`opensWith`, when the test says).
vi.mock('../private', async (orig) => {
  const real = await orig<typeof import('../private')>()
  return {
    ...real,
    unwrapKey: async (_facade: unknown, p: { readerPrivateKey: { hex: string }; repoId: Uint8Array; document: Record<string, unknown> }) => {
      const want = p.document['opensWith']
      if (typeof want === 'string' && want !== p.readerPrivateKey.hex) throw new real.WrapError('wrapUnreadable')
      return { reader: p.readerPrivateKey.hex, repo: bytesToHex(p.repoId) }
    },
  }
})

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
/** The encryption key the wallet's first approval registered beside its auth key. */
const WALLET_ENC = new Uint8Array(32).fill(0x11)
/** Its forge-collab approval: another auth key (7), and another encryption key (8). */
const COLLAB_WIF = encodeWif(new Uint8Array(32).fill(7), NET)
const COLLAB_ENC = new Uint8Array(32).fill(0x22)
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

describe('a vault from an older wallet sign-in, and the encryption key (D27)', () => {
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
  const walletKey: WalletKey = { keyId: 5, wif: AUTH_WIF, scope: { core: true, collab: false, community: false, meta: true, unbounded: false }, limits: null }
  const detach: (() => void)[] = []
  const make = (): AuthController => {
    const c = new AuthController(async () => sdk, NET)
    detach.push(c.attach())
    return c
  }
  /** What the older sign-in left: the forge-core key, a forge-collab grant, both encryption keys. */
  async function olderVault(): Promise<void> {
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: AUTH_WIF, extra: [{ contractId: FORGE.collab, keyId: 7, wif: COLLAB_WIF }] }, PASSKEY)
    await storeEncryptionKey(NET, ID, 6, new Uint8Array(WALLET_ENC))
    await storeEncryptionKey(NET, ID, 8, new Uint8Array(COLLAB_ENC))
    releaseUnlocked() // a reload: the page's memory is gone
  }
  /** A repo's wrap to key `keyId` of ours, which opens only with `secret`. */
  const wrapTo = (keyId: number | null, secret: Uint8Array): UnwrapInput => ({
    document: { ...(keyId === null ? {} : { recipientKeyId: keyId, senderKeyId: 4 }), opensWith: bytesToHex(secret) },
    counterpartyKey: {} as never,
    repoId: new Uint8Array(32).fill(keyId ?? 0),
    epoch: 0,
  })
  const readerOf = async (ops: EncryptionOps, w: UnwrapInput): Promise<string> => ((await ops.unwrap(w)) as unknown as { reader: string }).reader

  beforeEach(() => {
    resetMemoryStores()
    vi.stubGlobal('window', fakeWindow())
    vi.stubGlobal('navigator', fakeNavigator)
    lockVault()
    gestures = 0
    keys = [authKey(5, AUTH_WIF), encKey(6, WALLET_ENC), authKey(7, COLLAB_WIF, FORGE.collab), encKey(8, COLLAB_ENC)]
  })
  afterEach(() => {
    for (const off of detach.splice(0)) off()
    vi.unstubAllGlobals()
  })

  it('unlocks with one gesture after a reload, signs on both contracts, and opens a wrap to either key', async () => {
    await olderVault()
    const tab = make()
    // A wallet key has no budget or expiry, so it is never kept: nothing resumes.
    expect(await tab.resume()).toBe(false)
    expect(await encryptionKeyState(NET, ID)).toBe('locked')
    await expect(withEncryptionKey(NET, ID, async () => 1)).rejects.toThrow(/unlock/)
    await tab.unlock(ID, 'passkey')
    expect(gestures).toBe(1)
    expect(tab.getState().session?.grants).toMatchObject({ core: true, collab: true })
    expect(tab.writeAuth?.getSigningKeyWif(FORGE.core)).toBe(AUTH_WIF)
    expect(tab.writeAuth?.getSigningKeyWif(FORGE.collab)).toBe(COLLAB_WIF)
    expect(await encryptionKeyState(NET, ID)).toBe('open')
    expect(await storedEncryptionKeyIds(NET, ID)).toEqual([8, 6])
    const ops = (await encryptionOps(sdk, NET, ID, FORGE.collab))!
    // Writers send from the newest; readers pick the key the wrap names.
    expect(ops.keyId).toBe(8)
    expect(await readerOf(ops, wrapTo(6, WALLET_ENC))).toBe(bytesToHex(WALLET_ENC))
    expect(await readerOf(ops, wrapTo(8, COLLAB_ENC))).toBe(bytesToHex(COLLAB_ENC))
    // A wrap naming no key id: each held key is tried in turn.
    expect(await readerOf(ops, wrapTo(null, WALLET_ENC))).toBe(bytesToHex(WALLET_ENC))
    // A wrap to a key this browser does not hold does not open.
    await expect(ops.unwrap(wrapTo(3, WALLET_ENC))).rejects.toBeInstanceOf(WrapError)
    // Both reads took the one gesture.
    expect(gestures).toBe(1)
  }, 30_000)

  it('never holds an encryption key in plaintext', async () => {
    await olderVault()
    const dump = JSON.stringify(await idbEntries('vault'), (_k, v: unknown) => (v instanceof Uint8Array ? bytesToHex(v) : v))
    expect(dump).not.toContain(bytesToHex(WALLET_ENC))
    expect(dump).not.toContain(bytesToHex(COLLAB_ENC))
  }, 30_000)

  it('a vault written with a single key entry reads as a set of one, and grows from it', async () => {
    await storeInVault(NET, { identityId: ID, keyId: 5, wif: AUTH_WIF }, PASSKEY)
    await storeEncryptionKey(NET, ID, 6, new Uint8Array(WALLET_ENC))
    // What the vault held before key sets: the one sealed entry itself, not a list.
    const at = (await idbEntries('vault')).map(([k]) => String(k)).find((k) => k.startsWith('vault-enc:'))!
    const list = (await idbGet<unknown[]>('vault', at))!
    expect(list).toHaveLength(1)
    await idbPut('vault', at, list[0])
    expect(await storedEncryptionKeyIds(NET, ID)).toEqual([6])
    expect(await withEncryptionKey(NET, ID, async (k, s) => [k, bytesToHex(s)])).toEqual([6, bytesToHex(WALLET_ENC)])
    await storeEncryptionKey(NET, ID, 8, new Uint8Array(COLLAB_ENC))
    expect(await storedEncryptionKeyIds(NET, ID)).toEqual([8, 6])
  }, 30_000)

  it('a wallet sign-in over a vault whose encryption key cannot be carried over says so (it brings none of its own)', async () => {
    const OLD = new Uint8Array(32).fill(0x45)
    keys = [encKey(3, OLD), authKey(5, AUTH_WIF)]
    await storeInVault(NET, { identityId: ID, keyId: 9, wif: encodeWif(new Uint8Array(32).fill(9), NET) }, PASSKEY)
    await storeEncryptionKey(NET, ID, 3, new Uint8Array(OLD))
    // This tab now holds a pasted key for the identity: it sees no stored encryption key (L2).
    lockVault()
    holdForSession(NET, { identityId: ID, keyId: 9, wif: encodeWif(new Uint8Array(32).fill(9), NET) })
    const c = make()
    await c.adoptWalletKeys(ID, [walletKey], PASSKEY)
    expect(c.getState().notice).toMatch(/not carried over/)
    expect(await storedEncryptionKeyIds(NET, ID)).toEqual([])
  }, 30_000)

  it('the repo banner names an approval of the older code as where the key came from, and no import', () => {
    expect(ENCRYPTION_KEY_OTHER_APPROVAL).toMatch(/another approval in your wallet's older code/)
    expect(ENCRYPTION_KEY_OTHER_APPROVAL).toMatch(/Repair/)
    expect(ENCRYPTION_KEY_OTHER_APPROVAL).not.toContain('Import')
  })
})
