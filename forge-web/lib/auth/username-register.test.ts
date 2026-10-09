/**
 * #452: a username is signed by the identity's own unbound CRITICAL (else HIGH) authentication key
 * from the identity file or the phrase. MASTER, a contract-bound key (this browser's, a wallet
 * login's) or a disabled key is never picked (platform v5.0.0-beta.3: MASTER is not in a batch's
 * allowed levels, and a bound key is refused outside its contract, paid). Nothing is sent when no
 * usable key is given.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { bytesToHex } from '@noble/hashes/utils.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeWif } from './wif'
import { authKeysFromFile } from './identity-file'

const NET = 'devnet' as const
const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const bytesOf = (n: number): Uint8Array => new Uint8Array(32).fill(n)
const wifOf = (n: number): string => encodeWif(bytesOf(n), NET)

const sent = vi.hoisted(() => ({ signedWith: [] as string[], names: [] as string[], keyIds: [] as number[] }))

vi.mock('@dashevo/evo-sdk', () => ({
  IdentitySigner: class {
    wif = ''
    addKeyFromWif(w: string): void {
      this.wif = w
    }
    free(): void {}
  },
}))

const { USERNAME_KEY_IDS, NoUsernameKeyError, pickUsernameKey, registerUsername } = await import('./username-register')

interface Key {
  keyId: number
  purposeNumber: number
  securityLevelNumber: number
  disabledAt?: bigint
  contractBounds?: { toJSON(): { $type: string; id: string } }
  validatePrivateKey(bytes: Uint8Array): boolean
}
const keyFor = (keyId: number, n: number, level: number, extra: Partial<Key> = {}): Key => ({
  keyId,
  purposeNumber: 0,
  securityLevelNumber: level,
  validatePrivateKey: (b) => bytesToHex(b) === bytesToHex(bytesOf(n)),
  ...extra,
})
const bound = { contractBounds: { toJSON: () => ({ $type: 'contractGroup', id: 'G6T1mjQZJ4pqjaraEw71RRSbVasd7JSbgsWfmLUgNhL2' }) } }

let keys: Key[] = []
const sdk = {
  identities: { fetch: async () => ({ publicKeys: keys, getPublicKeyById: (id: number) => ({ id }) }) },
  dpns: {
    registerName: async (o: { label: string; identityKey: { id: number }; signer: { wif: string } }) => {
      sent.names.push(o.label)
      sent.keyIds.push(o.identityKey.id)
      sent.signedWith.push(o.signer.wif)
      return { free: () => undefined }
    },
  },
} as unknown as EvoSDK

beforeEach(() => {
  sent.signedWith = []
  sent.names = []
  sent.keyIds = []
  keys = [keyFor(0, 1, 0), keyFor(1, 2, 2), keyFor(2, 3, 1), keyFor(5, 9, 2, bound)]
})

describe('the keys a username may be signed with', () => {
  it('derives the canonical CRITICAL (2), then HIGH (1), authentication keys from a phrase', () => {
    expect(USERNAME_KEY_IDS).toEqual([2, 1])
  })

  it('picks the first given key that is a live, unbound CRITICAL or HIGH auth key', () => {
    expect(pickUsernameKey(keys as never, [wifOf(3), wifOf(2)], NET)?.key.keyId).toBe(2)
    expect(pickUsernameKey(keys as never, [wifOf(2)], NET)?.key.keyId).toBe(1)
  })

  it('never picks MASTER, a contract-bound key or a disabled one', () => {
    expect(pickUsernameKey(keys as never, [wifOf(1)], NET)).toBeNull()
    expect(pickUsernameKey(keys as never, [wifOf(9)], NET)).toBeNull()
    keys = keys.map((k) => (k.keyId === 2 ? { ...k, disabledAt: 1n } : k))
    expect(pickUsernameKey(keys as never, [wifOf(3)], NET)).toBeNull()
    // A TRANSFER key at CRITICAL is no authentication key.
    keys = [keyFor(3, 4, 1, { purposeNumber: 3 })]
    expect(pickUsernameKey(keys as never, [wifOf(4)], NET)).toBeNull()
  })
})

describe('registerUsername', () => {
  it('signs the preorder + domain with the picked key', async () => {
    await registerUsername(sdk, { network: NET, identityId: ID, label: 'alice7', wifs: [wifOf(1), wifOf(3)] })
    expect(sent).toEqual({ names: ['alice7'], keyIds: [2], signedWith: [wifOf(3)] })
  })

  it('sends nothing when only the master or this browser’s key is given', async () => {
    await expect(registerUsername(sdk, { network: NET, identityId: ID, label: 'alice7', wifs: [wifOf(1), wifOf(9)] })).rejects.toBeInstanceOf(NoUsernameKeyError)
    expect(sent.names).toEqual([])
  })
})

describe('authKeysFromFile', () => {
  const file = (keysJson: unknown[], extra: Record<string, unknown> = {}): string => JSON.stringify({ network: 'devnet-sakura', identityId: ID, identityKeys: keysJson, ...extra })
  const k = (securityLevel: string, n: number, purpose = 'AUTHENTICATION') => ({ purpose, securityLevel, keyType: 'ECDSA_SECP256K1', privateKeyWif: wifOf(n) })

  it('takes CRITICAL before HIGH, and never MASTER or a TRANSFER key', () => {
    const m = authKeysFromFile(file([k('MASTER', 1), k('HIGH', 2), k('CRITICAL', 3), k('CRITICAL', 4, 'TRANSFER')]))
    expect(m).toMatchObject({ identityId: ID, networkKey: 'devnet-sakura', wifs: [wifOf(3), wifOf(2)], mnemonic: null })
  })

  it('refuses a file with neither such a key nor a phrase', () => {
    expect(() => authKeysFromFile(file([k('MASTER', 1)]))).toThrow(/no CRITICAL or HIGH/)
    expect(authKeysFromFile(file([k('MASTER', 1)], { mnemonic: 'abandon '.repeat(11) + 'about' })).wifs).toEqual([])
  })
})
