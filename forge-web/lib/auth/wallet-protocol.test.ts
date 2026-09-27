/**
 * Mobile wallet sign-in, offline: Forge's `dash-key:` / `dash-st:` against the shipped wallets'
 * parsers (ported in ./wallet-sim) and their own test vectors, and the login poll against a
 * simulated wallet answering on the legacy key-exchange contract and on App Connect.
 */

import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it } from 'vitest'

import type { ForgeIds } from '../deployments'
import { hash160 } from './asset-lock'
import { base58Decode, base58Encode } from './base58'
import {
  APP_CONNECT_CONTRACT_ID,
  AmbiguousWalletLogin,
  RequestExpired,
  awaitWalletAnswer,
  sameIdentifier,
  newLoginRequest,
  walletSignInSupported,
  type ResponseSource,
} from './app-connect'
import { buildKeyRegistration, isUnlimited, keyScope, loginKeys, scopeCovers, RevokedWalletKey } from './key-registration'
import { heldToDisable } from './limited-key'
import { authKeyFromLogin, encodeKeyRequest, encryptionKeyFromLogin, openEnvelope, protocolUri } from './wallet-protocol'
import { deriveLoginKey, parseKeyRequest, parseStRequest, sealLoginKeys, DashConnectUriException } from './wallet-sim'
import { decodeWif, encodeWif } from './wif'

const FORGE: ForgeIds = {
  core: 'GM7ozWV1MNuAxyMnrf4JngAyGSDickvLznGi72WMp8EL',
  collab: 'GCBfP3cMdxPNyAwEQC6ppfKCDEoNS9HHyF6aBrsK7fRr',
  group: 'G6T1mjQZJ4pqjaraEw71RRSbVasd7JSbgsWfmLUgNhL2',
}
const LEGACY = 'LegacyKeyExchange1111111111111111111111111111'.slice(0, 44)
const ALICE = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const MALLORY = '6jAyDGGcc6fgA7bsraQPriTAZ73Lkq5QgnenaRhqteHd'

describe('dash-key request: byte-compatible with the shipped wallets', () => {
  // Dash Wallet Android DashConnectUriTest.kt: SERIALIZED_REQUEST_HEX from the DApp fixtures,
  //   01 ‖ pub(priv = 0x01*32) ‖ cd*32 ‖ 0e ‖ "Login to Yappr"
  const FIXTURE =
    '01' + '031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f' + 'cd'.repeat(32) + '0e' + '4c6f67696e20746f205961707072'

  it('serializes the wallet fixture exactly', () => {
    const pub = secp.getPublicKey(new Uint8Array(32).fill(1), true)
    expect(bytesToHex(encodeKeyRequest(pub, new Uint8Array(32).fill(0xcd), 'Login to Yappr'))).toBe(FIXTURE)
  })

  it('parses yappr’s real testnet request (captured 2026-07-22) the way the wallets do', () => {
    const uri = 'dash-key:3pYF4Tv365PGzvLukfiqx44ZinzxvhwjF2nmwgxDu7GXQpsoH7V9VLi5u8fWKMCxVnuERp47QVLoceh4KvPU9a1Xs7PgAGMjeJmcGHyHQY7yry?n=t&v=1'
    const r = parseKeyRequest(uri)
    expect(r.network).toBe('t')
    expect(r.contractId.length).toBe(32)
  })

  it('emits a request the wallets accept, naming the contract Forge asked for', () => {
    for (const [network, code] of [['devnet', 'd'], ['testnet', 't'], ['mainnet', 'm']] as const) {
      const req = newLoginRequest(network, FORGE.core)
      expect(req.uri).toMatch(new RegExp(`^dash-key:[1-9A-HJ-NP-Za-km-z]+\\?n=${code}&v=1$`))
      const parsed = parseKeyRequest(req.uri)
      expect(parsed.network).toBe(code)
      expect(base58Encode(parsed.contractId)).toBe(FORGE.core)
      expect(parsed.label).toBe('Dash Forge')
      expect(bytesToHex(hash160(parsed.appEphemeralPubKey))).toBe(bytesToHex(req.appEphemeralPubKeyHash))
    }
  })

  it('never emits the extra keyIndex the old request carried (it shifted labelLen off byte 66)', () => {
    const body = base58Decode(newLoginRequest('devnet', FORGE.core).uri.slice(9).split('?')[0] as string)
    expect(body.length).toBe(67 + 'Dash Forge'.length)
    expect(body[66]).toBe('Dash Forge'.length)
  })

  it('refuses what the wallets refuse', () => {
    const pub = secp.getPublicKey(new Uint8Array(32).fill(1), true)
    expect(() => encodeKeyRequest(pub, new Uint8Array(32), 'x'.repeat(65))).toThrow(/64 bytes/)
    const good = encodeKeyRequest(pub, new Uint8Array(32), 'ok')
    // Trailing bytes beyond the label: iOS refuses anything longer than 67 + 64.
    const long = new Uint8Array([...encodeKeyRequest(pub, new Uint8Array(32), 'y'.repeat(64)), 0])
    expect(() => parseKeyRequest(`dash-key:${base58Encode(long)}?n=d&v=1`)).toThrow(DashConnectUriException)
    expect(() => parseKeyRequest(`dash-key:${base58Encode(good)}?n=d&v=2`)).toThrow(/version/)
    expect(() => parseKeyRequest(`dash-key:${base58Encode(good)}?n=x&v=1`)).toThrow(/network/)
    expect(() => parseKeyRequest(`dash-key://${base58Encode(good)}?n=d&v=1`)).toThrow(/\/\//)
  })

  it('carries no pairing code: the key-exchange protocol and the wallets have none', () => {
    expect(Object.keys(newLoginRequest('devnet', FORGE.core))).not.toContain('pairingCode')
  })

  it('claims Dash Wallet support on testnet only (Android checkTestnet; iOS devnet is internal-only)', () => {
    expect(walletSignInSupported('testnet')).toBe(true)
    expect(walletSignInSupported('devnet')).toBe(false)
    expect(walletSignInSupported('mainnet')).toBe(false)
  })
})

describe('key exchange envelope: the wallets’ vectors', () => {
  // Dash Wallet Android KeyExchangeCryptoTest.kt fixtures.
  const identityId = new Uint8Array(32).fill(0xab)
  const loginKey = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)

  it('derives the auth and encryption keys from a login key', () => {
    const id = base58Encode(identityId)
    expect(bytesToHex(authKeyFromLogin(loginKey, id))).toBe('e06ee7ae45f257741dab7379793c854829b67171af111238c664d9fd90603706')
    expect(bytesToHex(encryptionKeyFromLogin(loginKey, id))).toBe('6879c11819d1a60026adae34c296e83d13d06559ad63da41d03c44b203a90f80')
    expect(bytesToHex(hash160(new Uint8Array([1, 2, 3])))).toBe('9bc4860bb936abf262d7a51f74b4304833fee3b2')
  })

  it('opens a 60-byte legacy payload and an App Connect multi-key payload, and nothing tampered', async () => {
    const appPriv = new Uint8Array(32).fill(1)
    const appPub = secp.getPublicKey(appPriv, true)
    const walletPriv = new Uint8Array(32).fill(2)
    const walletPub = secp.getPublicKey(walletPriv, true)
    const one = await sealLoginKeys([loginKey], walletPriv, appPub, Uint8Array.from({ length: 12 }, (_, i) => i))
    expect(one.length).toBe(60)
    expect(await openEnvelope(appPriv, walletPub, one)).toEqual([loginKey])
    const two = await sealLoginKeys([loginKey, new Uint8Array(32).fill(5)], walletPriv, appPub)
    expect((await openEnvelope(appPriv, walletPub, two)).length).toBe(2)
    one[30] = one[30]! ^ 1
    await expect(openEnvelope(appPriv, walletPub, one)).rejects.toBeTruthy()
    await expect(openEnvelope(appPriv, walletPub, two.slice(0, 70))).rejects.toThrow(/malformed/)
  })
})

describe('dash-st key registration', () => {
  it('builds the tagless IdentityUpdate the wallets check: their two derived keys, no disables', async () => {
    const evo = await import('@dashevo/evo-sdk')
    await evo.EvoSDK.getLatestVersionNumber()
    const login = deriveLoginKey(new Uint8Array(32).fill(0x11), base58Decode(ALICE), base58Decode(FORGE.core))
    const keys = loginKeys(login, ALICE)
    const bytes = buildKeyRegistration(evo, { identityId: ALICE, revision: 4n, nonce: 7n, authKeyId: 9, keys, contractId: FORGE.core })
    const uri = protocolUri('dash-st', bytes, 'devnet')
    const st = parseStRequest(uri)
    // Tagless framing: the transition's own version byte (0), not StateTransition's tag (6).
    expect(st.transitionBytes[0]).toBe(0)
    const t = evo.IdentityUpdateTransition.fromBytes(st.transitionBytes).toJSON() as unknown as {
      identityId: string
      revision: number
      nonce: number
      disablePublicKeys: number[]
      addPublicKeys: { id: number; type: number; purpose: number; securityLevel: number; data: string; contractBounds: { $type: string; id: string } | null; signature: string }[]
    }
    expect(t.identityId).toBe(ALICE)
    expect([t.revision, t.nonce]).toEqual([4, 7])
    expect(t.disablePublicKeys).toEqual([])
    expect(t.addPublicKeys).toHaveLength(2)
    const [auth, encKey] = t.addPublicKeys
    // iOS validateKeyRegistration: auth = ECDSA_HASH160 AUTHENTICATION/HIGH = hash160(authPub).
    expect([auth!.type, auth!.purpose, auth!.securityLevel]).toEqual([2, 0, 2])
    expect(bytesToHex(Uint8Array.from(atob(auth!.data), (c) => c.charCodeAt(0)))).toBe(bytesToHex(keys.authData))
    expect(auth!.contractBounds).toEqual({ $type: 'singleContract', id: FORGE.core })
    expect(auth!.signature).toBe('')
    // enc = ECDSA_SECP256K1 ENCRYPTION/MEDIUM = encPub, with a proof of possession.
    expect([encKey!.type, encKey!.purpose, encKey!.securityLevel]).toEqual([0, 1, 3])
    expect(bytesToHex(Uint8Array.from(atob(encKey!.data), (c) => c.charCodeAt(0)))).toBe(bytesToHex(keys.encPub))
    expect(encKey!.contractBounds).toBeNull()
    const sig = Uint8Array.from(atob(encKey!.signature), (c) => c.charCodeAt(0))
    expect(sig.length).toBe(65)
    // The proof of possession verifies: compact recoverable (27 + 4 + recid) over sha256d of the
    // signable bytes, which exclude every signature, so recovering yields encPub.
    const signable = evo.IdentityUpdateTransition.fromBytes(st.transitionBytes).toStateTransition().getSignableBytes()
    const recovered = secp.recoverPublicKey(new Uint8Array([sig[0]! - 31, ...sig.slice(1)]), sha256(sha256(signable)), { prehash: false })
    expect(bytesToHex(recovered)).toBe(bytesToHex(keys.encPub))
    // The wallets' other framing: StateTransition with IdentityUpdate's tag (6) prepended.
    const tagged = evo.StateTransition.fromBytes(new Uint8Array([6, ...st.transitionBytes]))
    expect(bytesToHex(tagged.getSignableBytes())).toBe(bytesToHex(signable))
  }, 60_000)
})

describe('which keys Forge signs with', () => {
  const bound = (b: { $type: string; id: string } | null) => ({ contractBounds: b ? { toJSON: () => b } : undefined })

  it('scopes keys by their bounds', () => {
    expect(keyScope(bound({ $type: 'contractGroup', id: FORGE.group }), FORGE)).toEqual({ core: true, collab: true, unbounded: false })
    expect(keyScope(bound({ $type: 'singleContract', id: FORGE.core }), FORGE)).toEqual({ core: true, collab: false, unbounded: false })
    expect(keyScope(bound({ $type: 'singleContract', id: FORGE.collab }), FORGE)).toEqual({ core: false, collab: true, unbounded: false })
    expect(keyScope(bound(null), FORGE)).toEqual({ core: true, collab: true, unbounded: true })
    // Another app's key, a superseded group, or a document-type bound: not Forge's to use.
    expect(keyScope(bound({ $type: 'singleContract', id: APP_CONNECT_CONTRACT_ID }), FORGE)).toBeNull()
    expect(keyScope(bound({ $type: 'contractGroup', id: '23iVLZABbVQ5a4heSa6GLVbVqSWr74JTSESSMTEYNd6o' }), FORGE)).toBeNull()
    expect(keyScope(bound({ $type: 'documentType', id: FORGE.core }), FORGE)).toBeNull()
    const core = keyScope(bound({ $type: 'singleContract', id: FORGE.core }), FORGE)!
    expect(scopeCovers(core, FORGE, FORGE.core)).toBe(true)
    expect(scopeCovers(core, FORGE, FORGE.collab)).toBe(false)
    expect(scopeCovers(core, FORGE, 'SomeOtherContract')).toBe(false)
    // Even an unbounded key is only ever asked about Forge's two contracts.
    expect(scopeCovers(keyScope(bound(null), FORGE)!, FORGE, 'SomeOtherContract')).toBe(false)
  })

  it('flags a key without a budget or an expiry as unlimited', () => {
    expect(isUnlimited({ limits: null })).toBe(true)
    expect(isUnlimited({ limits: { remaining: 1n, total: 1n, expiresAt: null } })).toBe(true)
    expect(isUnlimited({ limits: { remaining: 1n, total: 1n, expiresAt: 1 } })).toBe(false)
  })

  it('disables only live HIGH keys the stored private key controls (a key id alone picks nothing)', () => {
    const wif = encodeWif(new Uint8Array(32).fill(3), 'devnet')
    const mk = (keyId: number, controls: boolean, extra: Partial<{ purposeNumber: number; securityLevelNumber: number; disabledAt: bigint }> = {}) => ({
      keyId,
      purposeNumber: 0,
      securityLevelNumber: 2,
      ...extra,
      validatePrivateKey: (b: Uint8Array) => controls && b.every((x) => x === 3),
    })
    const keys = [mk(0, true, { securityLevelNumber: 0 }), mk(1, true, { securityLevelNumber: 1 }), mk(5, true), mk(6, false), mk(7, true, { disabledAt: 1n })]
    const held = [0, 1, 5, 6, 7, 99].map((keyId) => ({ keyId, wif }))
    expect(heldToDisable(keys, held, 'devnet')).toEqual([5])
    expect(heldToDisable(keys, [{ keyId: 5, wif: 'not a wif' }], 'devnet')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The login poll against a simulated wallet
// ---------------------------------------------------------------------------

interface ChainKey {
  keyId: number
  priv: Uint8Array
  bounds: { $type: string; id: string } | null
  totalBudget?: bigint
  expiresAt?: bigint
  disabledAt?: bigint
  securityLevelNumber?: number
}

/** A stored contractId as rendered (base58 or base64) back to bytes. */
function contractBytes(v: unknown): Uint8Array {
  const s = String(v)
  return s.length === 44 && s.endsWith('=') ? Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) : base58Decode(s)
}

/** A fake SDK: identities with keys, and the two response contracts' documents. */
function fakeChain() {
  const identities = new Map<string, ChainKey[]>()
  const docs: { contract: string; json: Record<string, unknown> }[] = []
  const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
  const sdk = {
    identities: {
      async fetch(id: string) {
        const keys = identities.get(id)
        if (!keys) return undefined
        return {
          balance: 10n ** 11n,
          revision: 1n,
          publicKeys: keys.map((k) => ({
            keyId: k.keyId,
            purposeNumber: 0,
            securityLevelNumber: k.securityLevelNumber ?? 2,
            disabledAt: k.disabledAt,
            totalBudget: k.totalBudget,
            expiresAt: k.expiresAt,
            contractBounds: k.bounds ? { toJSON: () => k.bounds } : undefined,
            validatePrivateKey: (bytes: Uint8Array) => bytesToHex(bytes) === bytesToHex(k.priv),
          })),
        }
      },
      async keysRemainingBudgets(id: string, ids: number[]) {
        const keys = identities.get(id) ?? []
        return new Map(ids.map((i) => [i, keys.find((k) => k.keyId === i)?.totalBudget ?? null]))
      },
    },
    documents: {
      async query(q: { dataContractId: string; where: [string, string, string][]; limit?: number }) {
        const hash = q.where.find((w) => w[0] === 'appEphemeralPubKeyHash')?.[2]
        const contract = q.where.find((w) => w[0] === 'contractId')?.[2]
        const after = q.where.find((w) => w[0] === '$ownerId' && w[1] === '>')?.[2]
        const rows = docs
          .filter((d) => d.contract === q.dataContractId && d.json['appEphemeralPubKeyHash'] === hash)
          .filter((d) => contract === undefined || base58Encode(contractBytes(d.json['contractId'])) === contract)
          .filter((d) => after === undefined || String(d.json['$ownerId']) > after)
          .sort((a, b) => String(a.json['$ownerId']).localeCompare(String(b.json['$ownerId'])))
          .slice(0, q.limit ?? 100)
        return new Map(rows.map((r, i) => [String(i), { toJSON: () => r.json }]))
      },
    },
    contracts: { fetch: async () => ({}) },
  }
  /** A wallet answering `uri` for `identityId`, as the shipped wallets (legacy) or App Connect do. */
  async function answer(uri: string, identityId: string, opts: { source: 'legacy' | 'app-connect'; register?: Partial<ChainKey> | false; chainKey?: Uint8Array }) {
    const req = parseKeyRequest(uri)
    const login = deriveLoginKey(opts.chainKey ?? new Uint8Array(32).fill(0x11), base58Decode(identityId), req.contractId)
    const authPriv = authKeyFromLogin(login, identityId)
    if (opts.register !== false) {
      const keys = identities.get(identityId) ?? [{ keyId: 0, priv: new Uint8Array(32).fill(0x77), bounds: null, securityLevelNumber: 0 }]
      keys.push({ keyId: keys.length, priv: authPriv, bounds: { $type: 'singleContract', id: base58Encode(req.contractId) }, ...opts.register })
      identities.set(identityId, keys)
    } else if (!identities.has(identityId)) {
      identities.set(identityId, [{ keyId: 0, priv: new Uint8Array(32).fill(0x77), bounds: null, securityLevelNumber: 0 }])
    }
    const walletPriv = secp.utils.randomSecretKey()
    const payload = await sealLoginKeys([login], walletPriv, req.appEphemeralPubKey)
    docs.push({
      contract: opts.source === 'legacy' ? LEGACY : APP_CONNECT_CONTRACT_ID,
      json: {
        $ownerId: identityId,
        ...(opts.source === 'legacy' ? { contractId: base58Encode(req.contractId), keyIndex: 0 } : {}),
        appEphemeralPubKeyHash: toB64(hash160(req.appEphemeralPubKey)),
        walletEphemeralPubKey: toB64(secp.getPublicKey(walletPriv, true)),
        encryptedPayload: toB64(payload),
      },
    })
    return { authPriv, login }
  }
  return { sdk: sdk as unknown as EvoSDK, identities, docs, answer }
}

const SOURCES: ResponseSource[] = [
  { kind: 'legacy', contractId: LEGACY },
  { kind: 'app-connect', contractId: APP_CONNECT_CONTRACT_ID },
]
const fast = { network: 'devnet' as const, forge: FORGE, sources: SOURCES, intervalMs: 1, settleMs: 0 }

describe('login poll against a simulated wallet', () => {
  it('a returning shipped wallet (legacy contract): a forge-core key, unlimited', async () => {
    const chain = fakeChain()
    const req = newLoginRequest('devnet', FORGE.core)
    const { authPriv } = await chain.answer(req.uri, ALICE, { source: 'legacy' })
    const a = await awaitWalletAnswer(chain.sdk, req, fast)
    expect(a.kind).toBe('keys')
    if (a.kind !== 'keys') throw new Error('unreachable')
    expect(a.identityId).toBe(ALICE)
    expect(a.source).toBe('legacy')
    expect(a.keys[0]!.scope).toEqual({ core: true, collab: false, unbounded: false })
    expect(isUnlimited(a.keys[0]!)).toBe(true)
    expect(bytesToHex(decodeWif(a.keys[0]!.wif).privateKey)).toBe(bytesToHex(authPriv))
    expect(req.appEphemeralPriv.every((b) => b === 0)).toBe(true)
  })

  it('a first-time shipped wallet: asks for key registration (QR #2) with the derived keys', async () => {
    const chain = fakeChain()
    const req = newLoginRequest('devnet', FORGE.core)
    const { login } = await chain.answer(req.uri, ALICE, { source: 'legacy', register: false })
    const a = await awaitWalletAnswer(chain.sdk, req, fast)
    expect(a.kind).toBe('register')
    if (a.kind !== 'register') throw new Error('unreachable')
    expect(bytesToHex(a.keys.authData)).toBe(bytesToHex(loginKeys(login, ALICE).authData))
  })

  it('an App Connect wallet: a group-bound key with limits', async () => {
    const chain = fakeChain()
    const req = newLoginRequest('devnet', FORGE.core)
    await chain.answer(req.uri, ALICE, { source: 'app-connect', register: { bounds: { $type: 'contractGroup', id: FORGE.group }, totalBudget: 5n, expiresAt: BigInt(Date.now() + 1e9) } })
    const a = await awaitWalletAnswer(chain.sdk, req, fast)
    if (a.kind !== 'keys') throw new Error('expected keys')
    expect(a.source).toBe('app-connect')
    expect(a.keys[0]!.scope).toEqual({ core: true, collab: true, unbounded: false })
    expect(isUnlimited(a.keys[0]!)).toBe(false)
  })

  it('ignores a legacy response for another app (confused deputy across contracts)', async () => {
    const chain = fakeChain()
    const req = newLoginRequest('devnet', FORGE.core, 'Dash Forge', Date.now())
    const expiring = { ...req, expiresAt: Date.now() + 30 }
    await chain.answer(req.uri, ALICE, { source: 'legacy' })
    // The node hands back the row, but relabelled for another contract: Forge re-checks it.
    chain.docs[0]!.json['contractId'] = FORGE.collab
    await expect(awaitWalletAnswer(chain.sdk, expiring, fast)).rejects.toBeInstanceOf(RequestExpired)
  })

  it('refuses a key bound to another app, a CRITICAL key, and a revoked (disabled) key', async () => {
    for (const register of [{ bounds: { $type: 'singleContract', id: APP_CONNECT_CONTRACT_ID } }, { securityLevelNumber: 1 }, { disabledAt: 1n }]) {
      const chain = fakeChain()
      const req = newLoginRequest('devnet', FORGE.core)
      await chain.answer(req.uri, ALICE, { source: 'legacy', register })
      const outcome = awaitWalletAnswer(chain.sdk, { ...req, expiresAt: Date.now() + 50 }, fast)
      // A disabled key is never registered again: the wallet would bring back a revoked key.
      if ('disabledAt' in register) await expect(outcome).rejects.toBeInstanceOf(RevokedWalletKey)
      else await expect(outcome).rejects.toThrow(/outside Dash Forge|HIGH/)
    }
  })

  it('does not settle on a round that could not read every source', async () => {
    const chain = fakeChain()
    const req = newLoginRequest('devnet', FORGE.core)
    await chain.answer(req.uri, ALICE, { source: 'legacy' })
    // The App Connect read fails every time: the legacy answer is there, but never accepted.
    const query = chain.sdk.documents.query.bind(chain.sdk.documents)
    ;(chain.sdk as unknown as { documents: { query: (q: { dataContractId: string }) => unknown } }).documents.query = (q) =>
      q.dataContractId === APP_CONNECT_CONTRACT_ID ? Promise.reject(new Error('node refused')) : query(q as never)
    const statuses: string[] = []
    await expect(awaitWalletAnswer(chain.sdk, { ...req, expiresAt: Date.now() + 60 }, { ...fast, onStatus: (s) => statuses.push(s) })).rejects.toBeInstanceOf(RequestExpired)
    expect(statuses).toContain('incomplete-read')
  })

  it('skips an unusable answerer but still counts it: a second answer is refused', async () => {
    const chain = fakeChain()
    const req = newLoginRequest('devnet', FORGE.core)
    await chain.answer(req.uri, MALLORY, { source: 'app-connect', chainKey: new Uint8Array(32).fill(0x22), register: { securityLevelNumber: 1 } })
    await chain.answer(req.uri, ALICE, { source: 'app-connect' })
    await expect(awaitWalletAnswer(chain.sdk, req, fast)).rejects.toBeInstanceOf(AmbiguousWalletLogin)
  })

  it('refuses when two identities answer (someone else saw the QR)', async () => {
    const chain = fakeChain()
    const req = newLoginRequest('devnet', FORGE.core)
    await chain.answer(req.uri, ALICE, { source: 'app-connect' })
    await chain.answer(req.uri, MALLORY, { source: 'app-connect', chainKey: new Uint8Array(32).fill(0x22) })
    await expect(awaitWalletAnswer(chain.sdk, req, fast)).rejects.toBeInstanceOf(AmbiguousWalletLogin)
  })

  it('skips responses not encrypted to this request, and, for a grant, other identities', async () => {
    const chain = fakeChain()
    const req = newLoginRequest('devnet', FORGE.collab)
    await chain.answer(req.uri, MALLORY, { source: 'app-connect', chainKey: new Uint8Array(32).fill(0x22) })
    chain.docs[0]!.json['encryptedPayload'] = btoa(String.fromCharCode(...new Uint8Array(60).fill(1)))
    await chain.answer(req.uri, ALICE, { source: 'legacy' })
    await chain.answer(req.uri, MALLORY, { source: 'app-connect', chainKey: new Uint8Array(32).fill(0x33) })
    const a = await awaitWalletAnswer(chain.sdk, req, { ...fast, identityId: ALICE })
    if (a.kind !== 'keys') throw new Error('expected keys')
    expect(a.identityId).toBe(ALICE)
    expect(a.keys[0]!.scope.collab).toBe(true)
  })

  it('a bad answer from a stranger does not stop the login; the sole bad answer does', async () => {
    const chain = fakeChain()
    const req = newLoginRequest('devnet', FORGE.core)
    await chain.answer(req.uri, MALLORY, { source: 'app-connect', chainKey: new Uint8Array(32).fill(0x22), register: { securityLevelNumber: 1 } })
    // Alone at settle: its reason is the answer.
    await expect(awaitWalletAnswer(chain.sdk, req, fast)).rejects.toThrow(/HIGH/)
    // A grant listens to one identity only: that identity's refusal is final at once.
    const chain2 = fakeChain()
    const req2 = newLoginRequest('devnet', FORGE.collab)
    await chain2.answer(req2.uri, ALICE, { source: 'app-connect', register: { bounds: { $type: 'singleContract', id: APP_CONNECT_CONTRACT_ID } } })
    await expect(awaitWalletAnswer(chain2.sdk, req2, { ...fast, identityId: ALICE })).rejects.toThrow(/outside Dash Forge/)
  })

  it('counts an answer still waiting for its key read: a quick stranger does not win', async () => {
    const chain = fakeChain()
    const req = newLoginRequest('devnet', FORGE.core)
    // ALICE answered, but her key is not visible on chain yet (App Connect registers first,
    // a lagging node does not show it): undecided. MALLORY's key is there.
    await chain.answer(req.uri, ALICE, { source: 'app-connect', register: false })
    await chain.answer(req.uri, MALLORY, { source: 'app-connect', chainKey: new Uint8Array(32).fill(0x22) })
    await expect(awaitWalletAnswer(chain.sdk, req, fast)).rejects.toBeInstanceOf(AmbiguousWalletLogin)
  })

  it('reads a contractId the SDK renders base64 as well as base58', async () => {
    const chain = fakeChain()
    const req = newLoginRequest('devnet', FORGE.core)
    await chain.answer(req.uri, ALICE, { source: 'legacy' })
    chain.docs[0]!.json['contractId'] = btoa(String.fromCharCode(...base58Decode(FORGE.core)))
    const a = await awaitWalletAnswer(chain.sdk, req, fast)
    expect(a.identityId).toBe(ALICE)
    expect(sameIdentifier(btoa(String.fromCharCode(...base58Decode(FORGE.collab))), FORGE.core)).toBe(false)
  })

  it('pages App Connect answers by $ownerId: junk cannot push the real answer out of reach', async () => {
    const chain = fakeChain()
    const req = newLoginRequest('devnet', FORGE.core)
    const hash = btoa(String.fromCharCode(...req.appEphemeralPubKeyHash))
    // 60 junk rows (not encrypted to us) sorting before the real answerer.
    for (let i = 0; i < 60; i++) {
      chain.docs.push({
        contract: APP_CONNECT_CONTRACT_ID,
        json: { $ownerId: `1111${String(i).padStart(3, '0')}`, appEphemeralPubKeyHash: hash, walletEphemeralPubKey: btoa(String.fromCharCode(...secp.getPublicKey(secp.utils.randomSecretKey(), true))), encryptedPayload: btoa(String.fromCharCode(...new Uint8Array(60).fill(i))) },
      })
    }
    await chain.answer(req.uri, ALICE, { source: 'app-connect', register: { bounds: { $type: 'contractGroup', id: FORGE.group }, totalBudget: 5n, expiresAt: BigInt(Date.now() + 1e9) } })
    const a = await awaitWalletAnswer(chain.sdk, req, fast)
    expect(a.identityId).toBe(ALICE)
  })

  it('expires', async () => {
    const chain = fakeChain()
    const req = newLoginRequest('devnet', FORGE.core, 'Dash Forge', Date.now() - 5 * 60 * 1000 - 1)
    expect(req.expiresAt).toBeLessThan(Date.now())
    await expect(awaitWalletAnswer(chain.sdk, req, fast)).rejects.toBeInstanceOf(RequestExpired)
    expect(req.appEphemeralPriv.every((b) => b === 0)).toBe(true)
  })
})
