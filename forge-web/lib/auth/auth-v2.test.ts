/**
 * Limited-key sign-in, offline: the vault's encryption and unlock rules, the App Connect
 * envelope, the asset-lock transaction, and the identity-file master-key extraction.
 */

import * as secp from '@noble/secp256k1'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { idbEntries, resetMemoryStores } from '../idb'
import {
  VaultLockedError,
  forgetVault,
  listVaults,
  lockVault,
  prfKey,
  sharedOriginProblem,
  storeInVault,
  unlockWithPassphrase,
  unlockedSecret,
} from './vault'
import { authKeyFromLogin, newRequest, openResponse } from './app-connect'
import { buildAssetLock, buildPayment, hash160, txid, verifiedUtxos, type Utxo } from './asset-lock'
import { masterMaterialFromFile } from './identity-file'
import { base58CheckEncode, base58Decode, base58Encode } from './base58'
import { encodeWif } from './wif'
import { purgeLegacyKeystore } from './controller'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const WIF = encodeWif(new Uint8Array(32).fill(7), 'devnet')
const SECRET = { identityId: ID, keyId: 5, wif: WIF }

describe('vault', () => {
  beforeEach(() => {
    resetMemoryStores()
    lockVault()
  })

  it('never stores the key in plaintext', async () => {
    await storeInVault('devnet', SECRET, { passphrase: 'correct horse battery' })
    const rows = await idbEntries<Record<string, unknown>>('vault')
    const dump = JSON.stringify(rows, (_k, v: unknown) => (v instanceof Uint8Array ? bytesToHex(v) : v))
    expect(dump).not.toContain(WIF)
    expect(dump).not.toContain(bytesToHex(new Uint8Array(32).fill(7)))
    expect(dump).not.toContain('correct horse')
  }, 30_000)

  it('unlocks with the right passphrase only, and locks again', async () => {
    await storeInVault('devnet', SECRET, { passphrase: 'correct horse battery' })
    lockVault()
    expect(unlockedSecret('devnet', ID)).toBeNull()
    await expect(unlockWithPassphrase('devnet', ID, 'wrong passphrase!!')).rejects.toBeInstanceOf(VaultLockedError)
    expect(await unlockWithPassphrase('devnet', ID, 'correct horse battery')).toEqual(SECRET)
    expect(unlockedSecret('devnet', ID)?.wif).toBe(WIF)
    expect(unlockedSecret('testnet', ID)).toBeNull()
    lockVault()
    expect(unlockedSecret('devnet', ID)).toBeNull()
  }, 60_000)

  it('refuses short passphrases and an unprotected vault', async () => {
    await expect(storeInVault('devnet', SECRET, { passphrase: 'short' })).rejects.toThrow(/at least/)
    await expect(storeInVault('devnet', SECRET, {})).rejects.toThrow(/passphrase or a passkey/)
  })

  it('binds a record to its network and identity (a copied record does not open)', async () => {
    await storeInVault('devnet', SECRET, { passphrase: 'correct horse battery' })
    const [[, record]] = (await idbEntries<Record<string, unknown>>('vault')) as [[string, Record<string, unknown>]]
    const { idbPut } = await import('../idb')
    const other = '6jAyDGGcc6fgA7bsraQPriTAZ73Lkq5QgnenaRhqteHd'
    await idbPut('vault', `vault:devnet:${other}`, { ...record, identityId: other })
    await expect(unlockWithPassphrase('devnet', other, 'correct horse battery')).rejects.toBeInstanceOf(VaultLockedError)
  }, 60_000)

  it('lists vaults without secrets and forgets them', async () => {
    await storeInVault('devnet', SECRET, { passphrase: 'correct horse battery' })
    expect(await listVaults('devnet')).toEqual([expect.objectContaining({ identityId: ID, keyId: 5, methods: ['passphrase'] })])
    await forgetVault('devnet', ID)
    expect(await listVaults('devnet')).toEqual([])
  }, 30_000)

  it('refuses shared origins (Pages project sites, IPFS path gateways) but not dedicated ones', () => {
    expect(sharedOriginProblem({ hostname: 'pastapastapasta.github.io', pathname: '/dash-forge/' })).toMatch(/dedicated origin/)
    expect(sharedOriginProblem({ hostname: 'ipfs.io', pathname: '/ipfs/bafy/' })).toMatch(/dedicated origin/)
    expect(sharedOriginProblem({ hostname: 'gw.example', pathname: '/ipns/forge.eth/' })).toMatch(/dedicated origin/)
    expect(sharedOriginProblem({ hostname: 'forge.dashhq.org', pathname: '/' })).toBeNull()
    expect(sharedOriginProblem({ hostname: 'bafy.ipfs.dweb.link', pathname: '/' })).toBeNull()
    expect(sharedOriginProblem({ hostname: '127.0.0.1', pathname: '/settings/' })).toBeNull()
  })

  it('stretches a passkey PRF output per identity', () => {
    const out = new Uint8Array(32).fill(1)
    expect(bytesToHex(prfKey(out, 'devnet', ID))).not.toBe(bytesToHex(prfKey(out, 'devnet', 'other')))
    expect(bytesToHex(prfKey(out, 'devnet', ID))).not.toBe(bytesToHex(out))
  })

  it('purges keys an earlier build left in localStorage', () => {
    const store = new Map<string, string>([['forge_key_devnet_pk_x', WIF], ['theme', 'dark']])
    const ls = {
      get length() {
        return store.size
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      removeItem: (k: string) => void store.delete(k),
    }
    ;(globalThis as { window?: unknown }).window = { localStorage: ls }
    try {
      purgeLegacyKeystore()
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
    expect([...store.keys()]).toEqual(['theme'])
  })
})

describe('App Connect envelope (Yappr key exchange)', () => {
  it('builds a dash-key request that carries the ephemeral key and contract', () => {
    const contract = 'GM7ozWV1MNuAxyMnrf4JngAyGSDickvLznGi72WMp8EL'
    const req = newRequest('devnet', contract)
    expect(req.uri).toMatch(/^dash-key:[1-9A-HJ-NP-Za-km-z]+\?n=d&v=1$/)
    const body = base58Decode(req.uri.slice('dash-key:'.length, req.uri.indexOf('?')))
    expect(body[0]).toBe(1)
    const pub = body.slice(1, 34)
    expect(bytesToHex(hash160(pub))).toBe(bytesToHex(req.appEphemeralPubKeyHash))
    expect(base58Encode(body.slice(34, 66))).toBe(contract)
    expect(req.pairingCode).toMatch(/^\d{6}$/)
  })

  it('opens what a wallet seals, and derives the auth key', async () => {
    const req = newRequest('devnet', 'GM7ozWV1MNuAxyMnrf4JngAyGSDickvLznGi72WMp8EL')
    const appPub = base58Decode(req.uri.slice(9, req.uri.indexOf('?'))).slice(1, 34)
    // The wallet side (BrowserLoginKeyProtocol.seal).
    const walletPriv = secp.utils.randomSecretKey()
    const walletPub = secp.getPublicKey(walletPriv, true)
    const sharedX = secp.getSharedSecret(walletPriv, appPub, true).slice(1, 33)
    const aes = hkdf(sha256, sharedX, new TextEncoder().encode('dash:key-exchange:v1'), new Uint8Array(0), 32)
    const loginKey = new Uint8Array(32).fill(9)
    const iv = new Uint8Array(12).fill(3)
    const k = await crypto.subtle.importKey('raw', aes, { name: 'AES-GCM' }, false, ['encrypt'])
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, loginKey))
    const payload = new Uint8Array([...iv, ...ct])
    expect(payload.length).toBe(60)
    expect(await openResponse(req, walletPub, payload)).toEqual(loginKey)
    const expected = hkdf(sha256, loginKey, base58Decode(ID), new TextEncoder().encode('auth'), 32)
    expect(authKeyFromLogin(loginKey, ID)).toEqual(expected)
    // A tampered payload fails authentication.
    payload[20] = (payload[20] as number) ^ 1
    await expect(openResponse(req, walletPub, payload)).rejects.toBeTruthy()
  })
})

describe('asset-lock transaction', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('locks the deposit minus the fee into one credit output with a valid signature', () => {
    const priv = new Uint8Array(32).fill(5)
    const pub = secp.getPublicKey(priv, true)
    const script = `76a914${bytesToHex(hash160(pub))}88ac`
    const utxo: Utxo = { txid: 'ab'.repeat(32), vout: 1, satoshis: 5_000_000, scriptPubKey: script, confirmations: 3 }
    const lock = buildAssetLock([utxo], priv)
    expect(lock.lockedDuffs).toBe(4_999_000)
    expect(lock.txid).toBe(txid(lock.raw))
    const hex = bytesToHex(lock.raw)
    // version 3, type 8
    expect(hex.startsWith('03000800')).toBe(true)
    // OP_RETURN output of the locked amount, and the payload's P2PKH credit output
    expect(hex).toContain('02' + '6a00')
    expect(hex).toContain(`1976a914${bytesToHex(hash160(pub))}88ac`)
    expect(hex).toContain(bytesToHex(pub))
  })

  it('is byte-identical to tools/mint-identity (the proven Node implementation)', () => {
    const priv = new Uint8Array(32).fill(5)
    const pub = secp.getPublicKey(priv, true)
    const utxo: Utxo = { txid: 'ab'.repeat(32), vout: 1, satoshis: 5_000_000, scriptPubKey: `76a914${bytesToHex(hash160(pub))}88ac`, confirmations: 1 }
    const lock = buildAssetLock([utxo], priv)
    // mint-identity createAssetLockTransaction(utxo, pub, 1000n) + signTransaction, RFC 6979.
    expect(bytesToHex(lock.raw)).toBe(
      '0300080001abababababababababababababababababababababababababababababababab010000006b483045022100a82f838bc838daf2a4391b133acad5fff55d7daa849467b08cd9897799de565202207d0722d008d64ce8161db287a3bf03fb7b5591e61f2dec7bc125786837cf2b3c01210362c0a046dacce86ddd0343c6d3c7c79c2208ba0d9c9cf24a6d046d21d21f90f7ffffffff0158474c0000000000026a000000000024010158474c00000000001976a9149d695474a303ac6d74d1796d3752f07895918bd288ac',
    )
    expect(lock.txid).toBe('452aa5a12caf5b23d314ac9ae8ef129a283f9a4c72492cff1fc5bf9cfc6d4fff')
  })

  describe('a lying block explorer', () => {
    const priv = new Uint8Array(32).fill(5)
    const pub = secp.getPublicKey(priv, true)
    const script = `76a914${bytesToHex(hash160(pub))}88ac`
    const address = base58CheckEncode(new Uint8Array([140, ...hash160(pub)]))
    // A funding transaction paying 5 DASH to the deposit address (built with the same code).
    const funding = buildPayment(
      [{ txid: 'cd'.repeat(32), vout: 0, satoshis: 600_000_000, scriptPubKey: script, confirmations: 9 }],
      priv,
      { address, duffs: 500_000_000 },
      address,
    )
    const ep = { insight: 'https://explorer.invalid', islockRpc: null }
    const serve = (rawtx: Uint8Array): void => {
      vi.stubGlobal('fetch', async (url: string) => ({ ok: true, json: async () => ({ rawtx: bytesToHex(rawtx) }), url }))
    }

    it('cannot make the lock burn the deposit by under-reporting its value', async () => {
      serve(funding.raw)
      const listed: Utxo[] = [{ txid: funding.txid, vout: 0, satoshis: 2_000_000, scriptPubKey: script, confirmations: 1 }]
      const utxos = await verifiedUtxos(ep, address, listed)
      expect(utxos[0]?.satoshis).toBe(500_000_000)
      const lock = buildAssetLock(utxos, priv)
      expect(lock.lockedDuffs).toBe(500_000_000 - 1000)
    })

    it('rejects a raw transaction that does not hash to the listed txid', async () => {
      serve(funding.raw)
      const listed: Utxo[] = [{ txid: 'ee'.repeat(32), vout: 0, satoshis: 500_000_000, scriptPubKey: script, confirmations: 1 }]
      await expect(verifiedUtxos(ep, address, listed)).rejects.toThrow(/not ee/)
    })

    it('drops outputs that do not pay the deposit address', async () => {
      serve(funding.raw)
      const listed: Utxo[] = [{ txid: funding.txid, vout: 1, satoshis: 500_000_000, scriptPubKey: script, confirmations: 1 }]
      // Output 1 is the change back to the same address in this fixture: still ours.
      expect((await verifiedUtxos(ep, address, listed)).length).toBe(1)
      const other: Utxo[] = [{ txid: funding.txid, vout: 7, satoshis: 1, scriptPubKey: script, confirmations: 1 }]
      expect(await verifiedUtxos(ep, address, other)).toEqual([])
    })

    it('refuses to sign inputs whose script is not the deposit key', () => {
      expect(() => buildAssetLock([{ txid: 'ab'.repeat(32), vout: 0, satoshis: 5_000_000, scriptPubKey: '76a914' + '00'.repeat(20) + '88ac', confirmations: 1 }], priv)).toThrow(
        /not paid to the deposit key/,
      )
    })
  })

  it('refuses a deposit that cannot pay its fee', () => {
    const priv = new Uint8Array(32).fill(5)
    expect(() => buildAssetLock([{ txid: 'ab'.repeat(32), vout: 0, satoshis: 900, scriptPubKey: '', confirmations: 1 }], priv)).toThrow()
  })
})

describe('identity file → master material', () => {
  it('takes the MASTER authentication key (and the mnemonic), nothing else', () => {
    const file = JSON.stringify({
      network: 'devnet-moutai',
      identityId: ID,
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      identityKeys: [
        { id: 0, purpose: 'AUTHENTICATION', securityLevel: 'MASTER', keyType: 'ECDSA_SECP256K1', privateKeyWif: WIF },
        { id: 1, purpose: 'AUTHENTICATION', securityLevel: 'HIGH', keyType: 'ECDSA_SECP256K1', privateKeyWif: encodeWif(new Uint8Array(32).fill(8), 'devnet') },
      ],
    })
    const m = masterMaterialFromFile(file)
    expect(m).toEqual({ identityId: ID, networkKey: 'devnet-moutai', masterWif: WIF, mnemonic: expect.stringContaining('abandon') })
  })

  it('refuses a file with neither a master key nor a mnemonic', () => {
    expect(() => masterMaterialFromFile(JSON.stringify({ identityId: ID, identityKeys: [] }))).toThrow(/MASTER/)
  })
})
