/**
 * The vault's ENCRYPTION-key slot (`docs/security/private-repos.md` §5.2): sealed beside the
 * limited key under the same unlock, never stored in plaintext, usable only while unlocked
 * (dropped on lock), carried across a key renewal, deleted with the vault; and the key-choice
 * rules (highest-id usable key, identity-file parsing).
 */

import { bytesToHex } from '@noble/hashes/utils.js'
import { beforeEach, describe, expect, it } from 'vitest'

import { idbEntries, resetMemoryStores } from '../idb'
import {
  encryptionMaterialFromFile,
  isUsableEncryptionKey,
  noEncryptionKeyMessage,
  usableEncryptionKey,
  wipeMaterial,
  type EncKeyLike,
} from './encryption-key'
import {
  forgetVault,
  holdForSession,
  lockVault,
  onEncryptionKeyChange,
  removeEncryptionKey,
  storeEncryptionKey,
  storeInVault,
  storedEncryptionKeyId,
  unlockWithPassphrase,
  withEncryptionKey,
} from './vault'
import { encodeWif } from './wif'

const ID = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const SECRET = { identityId: ID, keyId: 5, wif: encodeWif(new Uint8Array(32).fill(7), 'devnet') }
const ENC = new Uint8Array(32).fill(0x42)
const PASS = 'correct horse battery'

describe('the vault encryption-key slot', () => {
  beforeEach(() => {
    resetMemoryStores()
    lockVault()
  })

  it('seals the key beside the record, never in plaintext', async () => {
    await storeInVault('devnet', SECRET, { passphrase: PASS })
    await storeEncryptionKey('devnet', ID, 4, new Uint8Array(ENC))
    const dump = JSON.stringify(await idbEntries('vault'), (_k, v: unknown) => (v instanceof Uint8Array ? bytesToHex(v) : v))
    expect(dump).not.toContain(bytesToHex(ENC))
    expect(await storedEncryptionKeyId('devnet', ID)).toBe(4)
    expect(await withEncryptionKey('devnet', ID, async (keyId, secret) => [keyId, bytesToHex(secret)])).toEqual([4, bytesToHex(ENC)])
  }, 30_000)

  it('is unusable once locked, and usable again after unlock', async () => {
    await storeInVault('devnet', SECRET, { passphrase: PASS })
    await storeEncryptionKey('devnet', ID, 4, new Uint8Array(ENC))
    let changes = 0
    const off = onEncryptionKeyChange(() => {
      changes += 1
    })
    lockVault()
    off()
    expect(changes).toBe(1)
    await expect(withEncryptionKey('devnet', ID, async () => 1)).rejects.toThrow(/unlock/)
    await unlockWithPassphrase('devnet', ID, PASS)
    expect(await withEncryptionKey('devnet', ID, async (_k, s) => bytesToHex(s))).toBe(bytesToHex(ENC))
  }, 60_000)

  it('hands the callback a copy that is wiped afterwards', async () => {
    await storeInVault('devnet', SECRET, { passphrase: PASS })
    await storeEncryptionKey('devnet', ID, 4, new Uint8Array(ENC))
    let held: Uint8Array | null = null
    await withEncryptionKey('devnet', ID, async (_k, s) => {
      held = s
    })
    expect((held as Uint8Array | null)?.every((b) => b === 0)).toBe(true)
  }, 30_000)

  it('is carried across a key renewal and deleted with the vault', async () => {
    await storeInVault('devnet', SECRET, { passphrase: PASS })
    await storeEncryptionKey('devnet', ID, 4, new Uint8Array(ENC))
    await storeInVault('devnet', { ...SECRET, keyId: 6 }, { passphrase: 'another passphrase!' })
    expect(await withEncryptionKey('devnet', ID, async (_k, s) => bytesToHex(s))).toBe(bytesToHex(ENC))
    await forgetVault('devnet', ID)
    expect(await storedEncryptionKeyId('devnet', ID)).toBeNull()
  }, 60_000)

  it('can be removed on its own', async () => {
    await storeInVault('devnet', SECRET, { passphrase: PASS })
    await storeEncryptionKey('devnet', ID, 4, new Uint8Array(ENC))
    await removeEncryptionKey('devnet', ID)
    expect(await storedEncryptionKeyId('devnet', ID)).toBeNull()
    await expect(withEncryptionKey('devnet', ID, async () => 1)).rejects.toThrow(/no encryption key/)
  }, 30_000)

  it('a tab-only session holds it in memory only', async () => {
    holdForSession('devnet', SECRET)
    await storeEncryptionKey('devnet', ID, 4, new Uint8Array(ENC))
    expect(await idbEntries('vault')).toEqual([])
    expect(await storedEncryptionKeyId('devnet', ID)).toBe(4)
    lockVault()
    await expect(withEncryptionKey('devnet', ID, async () => 1)).rejects.toThrow(/unlock/)
  })

  it('needs the vault unlocked to store', async () => {
    await expect(storeEncryptionKey('devnet', ID, 4, new Uint8Array(ENC))).rejects.toThrow(/unlock/)
  })
})

describe('which encryption key counts', () => {
  const k = (keyId: number, extra: Partial<EncKeyLike> = {}): EncKeyLike => ({ keyId, purposeNumber: 1, keyTypeNumber: 0, data: '02', ...extra })
  const bound = (id: string, $type = 'singleContract') => ({ toJSON: () => ({ $type, id }) })

  it('enabled ENCRYPTION secp256k1, unbound or bound to forge-core; the highest id wins', () => {
    expect(isUsableEncryptionKey(k(4), 'CORE')).toBe(true)
    expect(isUsableEncryptionKey(k(4, { contractBounds: bound('CORE') }), 'CORE')).toBe(true)
    expect(isUsableEncryptionKey(k(4, { contractBounds: bound('OTHER') }), 'CORE')).toBe(false)
    expect(isUsableEncryptionKey(k(4, { contractBounds: bound('CORE', 'contractGroup') }), 'CORE')).toBe(false)
    expect(isUsableEncryptionKey(k(4, { disabledAt: 1n }), 'CORE')).toBe(false)
    expect(isUsableEncryptionKey(k(4, { purposeNumber: 2 }), 'CORE')).toBe(false)
    expect(isUsableEncryptionKey(k(4, { keyTypeNumber: 1 }), 'CORE')).toBe(false)
    expect(usableEncryptionKey([k(4), k(7), k(9, { disabledAt: 1n })], 'CORE')?.keyId).toBe(7)
    expect(usableEncryptionKey([], 'CORE')).toBeNull()
  })

  it('the add-member message is the spec\'s', () => {
    expect(noEncryptionKeyMessage('bob')).toBe(
      'bob has no encryption key yet. Send them this: `dg auth keys add --encryption`, or Settings → Keys → Enable private repos (one master-key signature).',
    )
  })

  it('reads an identity file\'s encryption keys and identity index, and never echoes it', () => {
    const file = JSON.stringify({
      identityId: ID,
      mnemonic: 'abandon '.repeat(11) + 'about',
      identityKeys: [
        { id: 0, purpose: 'AUTHENTICATION', securityLevel: 'MASTER', keyType: 'ECDSA_SECP256K1', privateKeyHex: '11'.repeat(32), derivationPath: "m/9'/1'/5'/0'/0'/3'/0'" },
        { id: 4, purpose: 'ENCRYPTION', securityLevel: 'MEDIUM', keyType: 'ECDSA_SECP256K1', privateKeyHex: '42'.repeat(32), derivationPath: "m/9'/1'/5'/0'/0'/3'/4'" },
      ],
    })
    const m = encryptionMaterialFromFile(file)
    expect(m.identityId).toBe(ID)
    expect(m.identityIndex).toBe(3)
    expect([...m.keys.keys()]).toEqual([4])
    expect(bytesToHex(m.keys.get(4) as Uint8Array)).toBe('42'.repeat(32))
    wipeMaterial(m)
    expect((m.keys.get(4) as Uint8Array).every((b) => b === 0)).toBe(true)
    expect(() => encryptionMaterialFromFile('{"privateKeyHex": "' + '42'.repeat(32))).toThrow('identity file is not valid JSON')
  })
})
