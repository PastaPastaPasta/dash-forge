/**
 * Forge's passkey vault against the core's in-memory port and software authenticator: what a
 * session may seal, the chain check an opened passkey must pass (planted entries refused), the
 * user-handle refusals, the cap, the copies handed back, and the rows Settings lists.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  KeyPurpose,
  KeyType,
  PasskeyError,
  recipientFromPrf,
  SecurityLevel,
  sealEntry,
  userHandleFor,
  VaultError,
  type OnChainKey,
  type SlotKey,
} from '../../vendor/platform-auth/passkey-vault'
import { fakePasskeyAdapter, type FakePasskeyAdapter } from '../../vendor/platform-auth/passkey-vault/__fixtures__/fake-passkey'
import { MemoryVaultPort } from '../../vendor/platform-auth/passkey-vault/__fixtures__/memory-port'
import { base58Encode } from '../base58'
import type { VaultSecret } from '../vault'
import { encodeWif } from '../wif'
import type { PasskeyMarker } from './markers'
import { FORGE_BUNDLE_CODEC, FORGE_BUNDLE_FORMAT, FORGE_VAULT_PROFILE } from './profile'
import { credentialName } from './port'
import {
  forgePasskeyVault,
  needsReseal,
  passkeyRows,
  platformPasskeyError,
  PlatformPasskeyError,
  passkeyIsUseless,
  sealableSession,
  vaultPasskeyFailure,
  verifyBundle,
  wipeSession,
  type ForgePasskeyVault,
  type VaultForgeIds,
} from './service'

const NET = 'devnet' as const
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000
const id32 = (n: number) => new Uint8Array(32).fill(n)
const FORGE: VaultForgeIds = { core: base58Encode(id32(11)), collab: base58Encode(id32(12)), community: base58Encode(id32(13)), meta: base58Encode(id32(14)), group: base58Encode(id32(15)) }
const OWNER = id32(7)
const IDENTITY = base58Encode(OWNER)
const RP = 'forge.dashhq.org'

const sk = (n: number) => new Uint8Array(32).fill(n)
const wifOf = (n: number) => encodeWif(sk(n), NET)
const pub = (n: number) => secp256k1.getPublicKey(sk(n), true)

/** A live key whose private key is `sk(id)`. */
function key(id: number, over: Partial<OnChainKey> = {}): OnChainKey {
  return { id, purpose: KeyPurpose.AUTHENTICATION, securityLevel: SecurityLevel.HIGH, type: KeyType.ECDSA_SECP256K1, disabled: false, ...over, data: over.data ?? pub(id) }
}
/** A Forge limited key (or v2 wallet key): group-bound, budgeted, expiring. */
const limited = (id: number, over: Partial<OnChainKey> = {}) =>
  key(id, { contractBounds: { kind: 'contractGroup', groupId: id32(15) }, totalBudget: 5_000_000_000n, remainingBudget: 4_000_000_000n, expiresAt: NOW + 90 * DAY, ...over })
/** A shipped wallet's grant: bound to one contract, no budget, no expiry. */
const grant = (id: number, contract: number) => key(id, { contractBounds: { kind: 'singleContract', contractId: id32(contract) } })
const encryptionKey = (id: number, over: Partial<OnChainKey> = {}) => key(id, { purpose: KeyPurpose.ENCRYPTION, securityLevel: SecurityLevel.MEDIUM, ...over })

const slot = (k: OnChainKey, privateKey = sk(k.id)): SlotKey => ({ purpose: k.purpose, securityLevel: k.securityLevel, keyType: k.type, keyId: k.id, privateKey })

let port: MemoryVaultPort
let adapter: FakePasskeyAdapter
let vault: ForgePasskeyVault

beforeEach(() => {
  port = new MemoryVaultPort()
  adapter = fakePasskeyAdapter({ multiDevice: true })
  vault = forgePasskeyVault({ port, adapter, rpId: RP, forge: FORGE, network: NET, now: () => NOW, sleep: async () => undefined })
})

const blank = { ownerId: OWNER, keys: [] as SlotKey[] }

/** Enrol a passkey and seal `secret` to it, as the controller does. */
async function enrolAndStore(secret: VaultSecret, keys: OnChainKey[], encryption: { keyId: number; secret: Uint8Array } | null = null) {
  port.setKeys(OWNER, keys)
  const pending = await vault.enroll(blank, { userName: 'Dash Forge' })
  const confirmed = await vault.confirm(pending)
  const s = sealableSession({ ownerId: OWNER, secret, keys, forge: FORGE, now: NOW, encryption })
  try {
    await vault.store(s, confirmed)
  } finally {
    wipeSession(s)
  }
  return { credentialId: pending.credentialId, recipientKey: confirmed.recipientKey }
}

/** An entry anyone with a live key of the owner could write, sealed to a passkey of the owner. */
async function plant(keys: SlotKey[], authKeyId = keys[0]!.keyId) {
  const created = await adapter.create({ rpId: RP, rpName: 'x', userHandle: userHandleFor(OWNER, id32(14)), userName: 'x', prfInput: vault.prfInput, exclude: [] })
  const recipientKey = recipientFromPrf(adapter.prfOf(created.credentialId, vault.prfInput)).publicKey
  const entry = sealEntry(FORGE_VAULT_PROFILE, {
    contractId: id32(14),
    ownerId: OWNER,
    credentialId: created.credentialId,
    recipientKey,
    bundle: { format: FORGE_BUNDLE_FORMAT, keys },
    codec: FORGE_BUNDLE_CODEC,
    authKeyId,
  })
  port.plant(OWNER, entry)
  adapter.choose(created.credentialId)
  return { credentialId: created.credentialId, recipientKey }
}

describe('a Forge passkey', () => {
  it('holds the main key and the live wallet grants, and signs in with them after the chain check', async () => {
    const keys = [key(0, { securityLevel: SecurityLevel.MASTER, data: pub(1) }), limited(5), grant(6, 12), grant(7, 13)]
    const secret: VaultSecret = { identityId: IDENTITY, keyId: 5, wif: wifOf(5), extra: [{ contractId: FORGE.collab, keyId: 6, wif: wifOf(6) }, { contractId: FORGE.community, keyId: 7, wif: wifOf(7) }] }
    const { credentialId } = await enrolAndStore(secret, keys)
    const opened = await vault.open()
    expect(opened.credentialId).toEqual(credentialId)
    expect(opened.result).toMatchObject({ keyId: 5, wif: wifOf(5), keyIds: [5, 6, 7], dropped: 0, encryption: null })
    expect(opened.result.extra).toEqual([
      { contractId: FORGE.collab, keyId: 6, wif: wifOf(6) },
      { contractId: FORGE.community, keyId: 7, wif: wifOf(7) },
    ])
    // The PRF output is wiped unless the caller keeps it (the sign-in does, for the browser vault).
    expect(opened.prfOutput).toBeNull()
    const kept = await vault.open({ keepPrfOutput: true })
    expect(kept.prfOutput).toEqual(adapter.prfOf(credentialId, vault.prfInput))
  })

  it('holds the encryption key only when given, and only the identity’s usable one', async () => {
    const keys = [limited(5), encryptionKey(9), encryptionKey(10, { disabled: true })]
    const secret: VaultSecret = { identityId: IDENTITY, keyId: 5, wif: wifOf(5) }
    const given = sk(9)
    await enrolAndStore(secret, keys, { keyId: 9, secret: given })
    // The caller's copy is its own: sealing did not wipe it.
    expect(given).toEqual(sk(9))
    const opened = await vault.open()
    expect(opened.result.encryption).toEqual({ keyId: 9, secret: sk(9) })
    expect(opened.result.keyIds).toEqual([5, 9])
    expect(() => sealableSession({ ownerId: OWNER, secret, keys, forge: FORGE, now: NOW, encryption: { keyId: 10, secret: sk(10) } })).toThrow(PlatformPasskeyError)
    expect(() => sealableSession({ ownerId: OWNER, secret, keys, forge: FORGE, now: NOW, encryption: { keyId: 9, secret: sk(8) } })).toThrow(/isn't your identity's current one/)
  })

  it.each([
    ['a key with no bounds', key(5, { totalBudget: 1n, expiresAt: NOW + DAY })],
    ['a shipped wallet’s one-contract key', grant(5, 11)],
    ['a group-bound key without a budget', limited(5, { totalBudget: undefined })],
    ['a group-bound key without an expiry', limited(5, { expiresAt: undefined })],
    ['a key of another group', limited(5, { contractBounds: { kind: 'contractGroup', groupId: id32(99) } })],
    ['a CRITICAL key', limited(5, { securityLevel: SecurityLevel.CRITICAL })],
    ['a disabled key', limited(5, { disabled: true })],
    ['a key in its last minutes', limited(5, { expiresAt: NOW + 60_000 })],
    ['a key with no budget left', limited(5, { remainingBudget: 0n })],
  ])('never seals %s as the main key', (_what, main) => {
    const secret: VaultSecret = { identityId: IDENTITY, keyId: 5, wif: wifOf(5) }
    expect(() => sealableSession({ ownerId: OWNER, secret, keys: [main], forge: FORGE, now: NOW })).toThrow(expect.objectContaining({ code: 'ineligible' }))
  })

  it('never seals a pasted tab-only key, nor a key the stored private key does not control', () => {
    const keys = [limited(5)]
    expect(() => sealableSession({ ownerId: OWNER, secret: { identityId: IDENTITY, keyId: -1, wif: wifOf(5) }, keys, forge: FORGE, now: NOW })).toThrow(PlatformPasskeyError)
    expect(() => sealableSession({ ownerId: OWNER, secret: { identityId: IDENTITY, keyId: 5, wif: wifOf(6) }, keys, forge: FORGE, now: NOW })).toThrow(PlatformPasskeyError)
  })

  it('leaves out held-only, unbounded, foreign, disabled, uncontrolled and surplus grants', () => {
    const keys = [limited(5), grant(6, 12), key(7), grant(8, 99), grant(9, 13), grant(10, 11), grant(20, 11), grant(21, 11), grant(22, 11), grant(23, 11), grant(24, 11)]
    keys[4] = { ...keys[4]!, disabled: true }
    const extra = [
      { contractId: FORGE.collab, keyId: 6, wif: wifOf(6), holdOnly: true as const },
      { contractId: FORGE.core, keyId: 7, wif: wifOf(7) },
      { contractId: FORGE.core, keyId: 8, wif: wifOf(8) },
      { contractId: FORGE.community, keyId: 9, wif: wifOf(9) },
      { contractId: FORGE.core, keyId: 10, wif: wifOf(11) },
      ...[20, 21, 22, 23, 24].map((n) => ({ contractId: FORGE.core, keyId: n, wif: wifOf(n) })),
    ]
    const s = sealableSession({ ownerId: OWNER, secret: { identityId: IDENTITY, keyId: 5, wif: wifOf(5), extra }, keys, forge: FORGE, now: NOW })
    // Slot 0 and four grants (one per Forge contract), then the encryption key: six slots.
    expect(s.keys.map((k) => k.keyId)).toEqual([5, 20, 21, 22, 23])
    const withEnc = sealableSession({ ownerId: OWNER, secret: { identityId: IDENTITY, keyId: 5, wif: wifOf(5), extra }, keys: [...keys, encryptionKey(30)], forge: FORGE, now: NOW, encryption: { keyId: 30, secret: sk(30) } })
    expect(withEnc.keys.map((k) => k.keyId)).toEqual([5, 20, 21, 22, 23, 30])
    wipeSession(s)
    expect(s.keys.every((k) => k.privateKey.every((b) => b === 0))).toBe(true)
  })
})

describe('signing in with a passkey refuses a planted entry', () => {
  const refused = async (keys: SlotKey[], onChain: OnChainKey[], why: RegExp) => {
    port.setKeys(OWNER, onChain)
    await plant(keys)
    const e = await vault.open().catch((x: unknown) => x)
    expect(e).toBeInstanceOf(VaultError)
    expect(e).toMatchObject({ code: 'refused' })
    expect(platformPasskeyError(e)).toMatchObject({ code: 'refused', message: expect.stringMatching(why) })
  }

  it('a key not on the identity', () => refused([slot(limited(5))], [limited(4)], /doesn't show the key/))
  it('a disabled key', () => refused([slot(limited(5))], [limited(5, { disabled: true })], /was disabled/))
  it('an expired key', () => refused([slot(limited(5))], [limited(5, { expiresAt: NOW - 1 })], /has expired.*don't recover an account/))
  it('a key with no budget left', () => refused([slot(limited(5))], [limited(5, { remainingBudget: 0n })], /no budget left/))
  it('an unbounded key', () => refused([slot(key(5))], [key(5, { totalBudget: 1n, expiresAt: NOW + DAY })], /doesn't sign in with/))
  it('a key of a foreign group', () => refused([slot(limited(5))], [limited(5, { contractBounds: { kind: 'contractGroup', groupId: id32(99) } })], /doesn't sign in with/))
  it('a key without a budget', () => refused([slot(limited(5))], [limited(5, { totalBudget: undefined, remainingBudget: undefined })], /doesn't sign in with/))
  it('a private key that is not the key’s', () => refused([slot(limited(5), sk(6))], [limited(5)], /doesn't sign in with/))

  it('drops planted grants and encryption keys, keeping the main key', async () => {
    port.setKeys(OWNER, [limited(5), key(7), encryptionKey(9, { contractBounds: { kind: 'contractGroup', groupId: id32(15) } }), grant(10, 12)])
    await plant([slot(limited(5)), slot(grant(6, 12)), slot(key(7)), slot(grant(10, 12), sk(11)), slot(encryptionKey(9))])
    const opened = await vault.open()
    expect(opened.result).toMatchObject({ keyId: 5, extra: [], encryption: null, keyIds: [5], dropped: 4 })
  })

  it('returns copies: the bundle the core wipes takes nothing the sign-in keeps', () => {
    const bundle = { format: FORGE_BUNDLE_FORMAT, keys: [slot(limited(5)), slot(encryptionKey(9))] }
    const opened = verifyBundle(bundle, [limited(5), encryptionKey(9)], { forge: FORGE, network: NET, now: NOW })
    FORGE_BUNDLE_CODEC.wipe(bundle)
    expect(bundle.keys[1]!.privateKey.every((b) => b === 0)).toBe(true)
    expect(opened.encryption?.secret).toEqual(sk(9))
    expect(opened.wif).toBe(wifOf(5))
  })
})

describe('a passkey that is not one of this vault’s', () => {
  it('a browser-only passkey (a random 32-byte handle) only unlocks the browser that made it', async () => {
    port.setKeys(OWNER, [limited(5)])
    await plant([slot(limited(5))])
    adapter.overrideNextHandle(new Uint8Array(32).fill(1))
    const e = await vault.open().catch((x: unknown) => x)
    expect(e).toBeInstanceOf(PasskeyError)
    expect(platformPasskeyError(e)).toMatchObject({ code: 'not-vault', message: expect.stringMatching(/only unlocks the browser that made it/) })
  })

  it('a passkey for another network’s vault', async () => {
    port.setKeys(OWNER, [limited(5)])
    await plant([slot(limited(5))])
    adapter.overrideNextHandle(userHandleFor(OWNER, id32(42)))
    expect(platformPasskeyError(await vault.open().catch((x: unknown) => x))).toMatchObject({ code: 'other-vault' })
  })
})

describe('the passkeys of one identity', () => {
  it('are capped at 10', async () => {
    port.setKeys(OWNER, [limited(5)])
    for (let i = 0; i < 10; i++) await plant([slot(limited(5))])
    const e = await vault.enroll(blank, { userName: 'x' }).catch((x: unknown) => x)
    expect(platformPasskeyError(e)).toMatchObject({ code: 'too-many' })
    expect(adapter.calls.create).toHaveLength(10)
  })

  it('list as this device’s only with this device’s recipient key, and say which need an update', async () => {
    const keys = [limited(5), limited(4, { disabled: true }), grant(6, 12)]
    const mine = await plant([slot(limited(5)), slot(grant(6, 12))])
    const other = await plant([slot(limited(4))])
    const replaced = await plant([slot(limited(5))])
    const markers: PasskeyMarker[] = [
      { credentialId: mine.credentialId, recipientKey: mine.recipientKey, keyIds: [5, 6], addedAt: 1 },
      // An entry replaced since (another recipient key): not this device's any more.
      { credentialId: replaced.credentialId, recipientKey: id32(1), keyIds: [5], addedAt: 1 },
    ]
    const rows = passkeyRows({ entries: await port.list(OWNER), markers, keys, authIds: [5, 6], usableEncryptionId: null, now: NOW })
    const row = (c: Uint8Array) => rows.find((r) => r.id === credentialName(c))
    expect(row(mine.credentialId)).toMatchObject({ thisDevice: true, keyId: 5, keyState: 'live', current: true, needsUpdate: false })
    expect(row(other.credentialId)).toMatchObject({ thisDevice: false, keyId: 4, keyState: 'disabled', current: false, needsUpdate: true })
    expect(row(replaced.credentialId)).toMatchObject({ thisDevice: false, current: true, needsUpdate: false })
    // The session now holds another grant: this device's entry needs a re-seal.
    expect(passkeyRows({ entries: await port.list(OWNER), markers, keys, authIds: [5], usableEncryptionId: null, now: NOW }).find((r) => r.thisDevice)?.needsUpdate).toBe(true)
  })

  it('need a re-seal for a new main key, other grants or a replaced encryption key', () => {
    const m: PasskeyMarker = { credentialId: id32(1), recipientKey: id32(2), keyIds: [5, 6, 9], encryptionKeyId: 9, addedAt: 1 }
    expect(needsReseal({ authKeyId: 5 }, m, [5, 6], 9)).toBe(false)
    expect(needsReseal({ authKeyId: 4 }, m, [5, 6], 9)).toBe(true)
    expect(needsReseal({ authKeyId: 5 }, m, [5], 9)).toBe(true)
    expect(needsReseal({ authKeyId: 5 }, m, [5, 6], 10)).toBe(true)
    expect(needsReseal({ authKeyId: 5 }, null, [5, 6], null)).toBe(false)
  })
})

describe('a WebAuthn failure', () => {
  it('keeps its code through the browser adapter, in the browser vault’s words', () => {
    const closed = vaultPasskeyFailure(new DOMException('The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/', 'NotAllowedError'), 'get')
    expect(closed).toBeInstanceOf(PasskeyError)
    expect(closed.code).toBe('cancelled')
    expect(closed.message).not.toMatch(/w3\.org/)
    expect(vaultPasskeyFailure(new DOMException('x', 'InvalidStateError'), 'create').code).toBe('exists')
    expect(vaultPasskeyFailure(new DOMException('x', 'SecurityError'), 'create').code).toBe('unsupported')
    expect(platformPasskeyError(vaultPasskeyFailure(new DOMException('x', 'SecurityError'), 'get'))).toMatchObject({ code: 'unavailable' })
    const own = new PasskeyError('no prf', 'no-prf')
    expect(vaultPasskeyFailure(own, 'get')).toBe(own)
  })

  it('drops a new passkey only when it can never hold the key', () => {
    expect(passkeyIsUseless(new PasskeyError('x', 'no-prf'))).toBe(true)
    expect(passkeyIsUseless(new VaultError('x', 'mismatch'))).toBe(true)
    expect(passkeyIsUseless(new PasskeyError('x', 'cancelled'))).toBe(false)
    expect(passkeyIsUseless(new PasskeyError('x', 'timeout'))).toBe(false)
    expect(passkeyIsUseless(new Error('network'))).toBe(false)
  })
})
