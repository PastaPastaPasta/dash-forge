import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { bytesEqual, concatBytes, readU32be, u32be, wipe } from './bytes'
import { isValidPrivateKey, seedCodec, slotKeysCodec, votingKeysCodec, type SlotBundle, type SlotKey } from './codecs'
import { VaultCryptoError } from './errors'
import { defineProfile, sealedLengths } from './profile'
import { forgeProfile, forgeSlots, govhubKey, govhubProfile, govhubSeed, govhubVoting, yapprProfile, yapprRaw, yapprRing } from './__fixtures__/profiles'

const H = (label: string) => sha256(new TextEncoder().encode(label))
const key = (over: Partial<SlotKey> = {}): SlotKey => ({ purpose: 0, securityLevel: 2, keyType: 0, keyId: 2, privateKey: H(`key ${over.keyId ?? 2}`), ...over })
const ENC: SlotKey = { purpose: 1, securityLevel: 3, keyType: 0, keyId: 6, privateKey: H('encryption key') }
const flip = (bytes: Uint8Array, index: number) => {
  const copy = bytes.slice()
  copy[index] = (copy[index] ?? 0) ^ 1
  return copy
}
const N = hexToBytes('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')

describe('bytes', () => {
  it('u32be round-trips and refuses out-of-range values', () => {
    for (const v of [0, 1, 0x7fffffff, 0x80000001, 0xffffffff]) expect(readU32be(u32be(v), 0)).toBe(v)
    expect(() => u32be(-1)).toThrow(RangeError)
    expect(() => u32be(2 ** 32)).toThrow(RangeError)
    expect(() => u32be(1.5)).toThrow(RangeError)
    expect(() => readU32be(new Uint8Array(3), 0)).toThrow(RangeError)
  })

  it('concat, equal, wipe', () => {
    const a = concatBytes(Uint8Array.of(1), Uint8Array.of(2, 3))
    expect(Array.from(a)).toEqual([1, 2, 3])
    expect(bytesEqual(a, Uint8Array.of(1, 2, 3))).toBe(true)
    expect(bytesEqual(a, Uint8Array.of(1, 2))).toBe(false)
    expect(bytesEqual(a, Uint8Array.of(1, 2, 4))).toBe(false)
    wipe(a, null, undefined)
    expect(Array.from(a)).toEqual([0, 0, 0])
  })

  it('secp256k1 private key validity: [1, n)', () => {
    expect(isValidPrivateKey(H('x'))).toBe(true)
    expect(isValidPrivateKey(new Uint8Array(32))).toBe(false)
    expect(isValidPrivateKey(N)).toBe(false)
    expect(isValidPrivateKey(flip(N, 31).fill(0xff, 31))).toBe(false)
    const nMinus1 = N.slice()
    nMinus1[31] = 0x40
    expect(isValidPrivateKey(nMinus1)).toBe(true)
    expect(isValidPrivateKey(new Uint8Array(31).fill(1))).toBe(false)
  })
})

describe('slotKeysCodec', () => {
  it('lays out format, count and 39-byte slots, zero-padded to the length', () => {
    const k = key({ purpose: 0, securityLevel: 2, keyType: 2, keyId: 0x01020304 })
    const out = yapprRaw.encode({ format: 1, keys: [k] })
    expect(out.length).toBe(80)
    expect(Array.from(out.subarray(0, 9))).toEqual([1, 1, 0, 2, 2, 1, 2, 3, 4])
    expect(bytesToHex(out.subarray(9, 41))).toBe(bytesToHex(k.privateKey))
    expect(out.subarray(41).every((b) => b === 0)).toBe(true)
  })

  it("is govhub's KEY layout with one slot: purpose at 2, level at 3, type at 4, key id at 5, key at 9", () => {
    const out = govhubKey.encode({ format: 2, keys: [key()] })
    expect(out.length).toBe(240)
    expect([out[0], out[1], out[2], out[3], out[4], readU32be(out, 5)]).toEqual([2, 1, 0, 2, 0, 2])
    expect(bytesToHex(out.subarray(9, 41))).toBe(bytesToHex(key().privateKey))
  })

  it('round-trips, and decode returns copies', () => {
    const bundle: SlotBundle = { format: 1, keys: [key(), ENC] }
    const bytes = yapprRaw.encode(bundle)
    const back = yapprRaw.decode(bytes, 2)
    expect(back).toEqual(bundle)
    bytes.fill(0)
    expect(back.keys[0]!.privateKey).toEqual(key().privateKey)
    expect(yapprRaw.authKeyIdOf?.(back)).toBe(2)
    yapprRaw.wipe(back)
    expect(back.keys.every((k) => k.privateKey.every((b) => b === 0))).toBe(true)
  })

  it('refuses counts, repeats, bad keys and ids out of range (encode)', () => {
    const enc = (keys: SlotKey[]) => () => yapprRing.encode({ format: 2, keys })
    expect(enc([])).toThrow(/1 to 4 keys/)
    expect(enc([key(), key({ keyId: 3 }), key({ keyId: 4 }), key({ keyId: 5 }), key({ keyId: 9 })])).toThrow(/1 to 4 keys/)
    expect(enc([key(), { ...ENC, keyId: 2 }])).toThrow(/appears twice/)
    expect(enc([key({ privateKey: new Uint8Array(31) })])).toThrow(/32 bytes/)
    expect(enc([key({ privateKey: new Uint8Array(32) })])).toThrow(/valid secp256k1/)
    expect(enc([key({ privateKey: N })])).toThrow(/valid secp256k1/)
    expect(enc([key({ keyId: 2 ** 32 })])).toThrow(/out of range/)
    expect(() => yapprRing.encode({ format: 1, keys: [key()] })).toThrow(/not of this format/)
  })

  it('refuses on decode: wrong length or format byte, count, padding, slot 0 not the entry key', () => {
    const bytes = yapprRaw.encode({ format: 1, keys: [key()] })
    const code = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        return e instanceof VaultCryptoError ? e.code : 'other'
      }
      return 'none'
    }
    expect(code(() => yapprRaw.decode(bytes.slice(0, 79), 2))).toBe('format')
    expect(code(() => yapprRaw.decode(concatBytes(bytes, Uint8Array.of(0)), 2))).toBe('format')
    const relabelled = bytes.slice()
    relabelled[0] = 2
    expect(code(() => yapprRaw.decode(relabelled, 2))).toBe('format')
    expect(() => yapprRaw.decode(flip(bytes, 79), 2)).toThrow(/padding/)
    expect(() => yapprRaw.decode(flip(bytes, 41), 2)).toThrow(/padding/)
    expect(() => yapprRaw.decode(bytes, 6)).toThrow(/slot 0 is not/)
    const zero = bytes.slice()
    zero[1] = 0
    expect(() => yapprRaw.decode(zero, 2)).toThrow(/key count/)
    const three = bytes.slice()
    three[1] = 3
    expect(() => yapprRaw.decode(three, 2)).toThrow(/key count/)
  })

  it('wipes the keys it decoded when a rule refuses the bundle', () => {
    let seen: readonly SlotKey[] = []
    const spy = slotKeysCodec({
      id: 7,
      length: 80,
      maxKeys: 2,
      allow: () => true,
      check: (keys) => {
        seen = keys as readonly SlotKey[]
        return 'refused by check'
      },
    })
    const bytes = new Uint8Array(80)
    bytes.set([7, 1, 0, 2, 0, 0, 0, 0, 2])
    bytes.set(H('k'), 9)
    expect(() => spy.decode(bytes, 2)).toThrow(/refused by check/)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.privateKey.every((b) => b === 0)).toBe(true)
  })

  it('checks its own shape at construction', () => {
    const allow = () => true
    expect(() => slotKeysCodec({ id: 1, length: 79, maxKeys: 2, allow })).toThrow(/at least 80/)
    expect(() => slotKeysCodec({ id: 0, length: 80, maxKeys: 2, allow })).toThrow(/1 to 255/)
    expect(() => slotKeysCodec({ id: 1, length: 80, maxKeys: 0, allow })).toThrow(/maxKeys/)
    expect(forgeSlots.length).toBeGreaterThanOrEqual(2 + 6 * 39)
  })
})

describe("Yappr's rules", () => {
  const raw = (keys: SlotKey[]) => () => yapprRaw.encode({ format: 1, keys })
  const ring = (keys: SlotKey[]) => () => yapprRing.encode({ format: 2, keys })

  it('never a MASTER or TRANSFER key, nor a messaging key at another level; slot 0 is the sign-in key', () => {
    expect(raw([key({ securityLevel: 0 })])).toThrow(/slot 0 may not/)
    expect(raw([key({ purpose: 3, securityLevel: 1 })])).toThrow(/slot 0 may not/)
    expect(raw([ENC])).toThrow(/slot 0 may not/)
    expect(raw([key(), { ...ENC, purpose: 3 }])).toThrow(/slot 1 may not/)
    expect(raw([key(), { ...ENC, securityLevel: 2 }])).toThrow(/slot 1 may not/)
    expect(raw([key(), { ...ENC, purpose: 2 }])).toThrow(/slot 1 may not/)
    expect(ring([key(), { ...ENC, purpose: 2 }])).not.toThrow()
    expect(ring([key({ securityLevel: 1, keyId: 7 }), key({ securityLevel: 0, keyId: 8 })])).toThrow(/slot 1 may not/)
  })

  it('one sign-in key per raw bundle; CRITICAL taken at the codec', () => {
    expect(raw([key(), key({ keyId: 3 })])).toThrow(/one sign-in key/)
    expect(raw([key({ securityLevel: 1 })])).not.toThrow()
    expect(ring([key(), key({ keyId: 3 }), ENC])).not.toThrow()
  })
})

describe("govhub's formats", () => {
  it('SEED: format ‖ len ‖ u32be index ‖ entropy, refuses bad lengths, index and padding', () => {
    const entropy = H('seed').slice(0, 16)
    const bytes = govhubSeed.encode({ format: 1, identityIndex: 3, entropy })
    expect(bytes.length).toBe(240)
    expect(Array.from(bytes.subarray(0, 6))).toEqual([1, 16, 0, 0, 0, 3])
    expect(govhubSeed.decode(bytes, 0)).toEqual({ format: 1, identityIndex: 3, entropy })
    expect(govhubSeed.decode(govhubSeed.encode({ format: 1, identityIndex: 0, entropy: H('32') }), 0).entropy.length).toBe(32)
    expect(() => govhubSeed.encode({ format: 1, identityIndex: 0, entropy: new Uint8Array(20) })).toThrow(/entropy/)
    expect(() => govhubSeed.encode({ format: 1, identityIndex: 0x80000000, entropy })).toThrow(/identity index/)
    expect(() => govhubSeed.decode(flip(bytes, 200), 0)).toThrow(/padding/)
    const len = bytes.slice()
    len[1] = 20
    expect(() => govhubSeed.decode(len, 0)).toThrow(/entropy/)
    const seed = govhubSeed.decode(bytes, 0)
    govhubSeed.wipe(seed)
    expect(seed.entropy.every((b) => b === 0)).toBe(true)
  })

  it('VOTING_KEYS: 1 to 7 distinct valid keys', () => {
    const keys = [H('v1'), H('v2')]
    const bytes = govhubVoting.encode({ format: 3, keys })
    expect(govhubVoting.decode(bytes, 0)).toEqual({ format: 3, keys })
    expect(() => govhubVoting.encode({ format: 3, keys: Array.from({ length: 8 }, (_, i) => H(`v${i}`)) })).toThrow(/1 to 7/)
    expect(() => govhubVoting.encode({ format: 3, keys: [H('v1'), H('v1')] })).toThrow(/twice/)
    expect(() => govhubVoting.encode({ format: 3, keys: [new Uint8Array(32)] })).toThrow(/invalid/)
    expect(() => govhubVoting.decode(flip(bytes, 100), 0)).toThrow(/padding/)
  })

  it('KEY: only HIGH or CRITICAL authentication, never MASTER, MEDIUM or TRANSFER; the key must be the entry key', () => {
    const enc = (k: SlotKey) => () => govhubKey.encode({ format: 2, keys: [k] })
    expect(enc(key({ securityLevel: 0, keyId: 0 }))).toThrow(VaultCryptoError)
    expect(enc(key({ purpose: 3, securityLevel: 1, keyId: 3 }))).toThrow(VaultCryptoError)
    expect(enc(key({ securityLevel: 3 }))).toThrow(VaultCryptoError)
    expect(enc(key({ securityLevel: 1 }))).not.toThrow()
    const e = govhubKey.encode({ format: 2, keys: [key()] })
    expect(() => govhubKey.decode(e, 1)).toThrow(/slot 0/)
    const forged = e.slice()
    forged[3] = 0
    expect(() => govhubKey.decode(forged, 2)).toThrow(VaultCryptoError)
    expect(() => govhubKey.encode({ format: 2, keys: [key(), key({ keyId: 3 })] })).toThrow(/1 to 1 keys/)
  })
})

describe("Forge's rules", () => {
  const enc = (keys: SlotKey[]) => () => forgeSlots.encode({ format: 1, keys })
  const grants = [3, 4, 5, 7].map((keyId) => key({ keyId }))

  it('holds the main key, four grants and the encryption key in 236 of 240 bytes', () => {
    const bytes = forgeSlots.encode({ format: 1, keys: [key(), ...grants, ENC] })
    expect(bytes[1]).toBe(6)
    expect(bytes.subarray(236).every((b) => b === 0)).toBe(true)
    expect(bytes[235]).not.toBe(0)
    expect(enc([key(), ...grants, ENC, key({ keyId: 9 })])).toThrow(/1 to 6 keys/)
  })

  it('never MASTER, CRITICAL, TRANSFER; HIGH authentication in slot 0; one MEDIUM encryption key at most', () => {
    expect(enc([key({ securityLevel: 0 })])).toThrow(/slot 0/)
    expect(enc([key({ securityLevel: 1 })])).toThrow(/slot 0/)
    expect(enc([key({ purpose: 3, securityLevel: 1 })])).toThrow(/slot 0/)
    expect(enc([ENC])).toThrow(/slot 0/)
    expect(enc([key(), key({ keyId: 3, securityLevel: 1 })])).toThrow(/slot 1/)
    expect(enc([key(), { ...ENC, securityLevel: 2 }])).toThrow(/slot 1/)
    expect(enc([key(), { ...ENC, purpose: 2 }])).toThrow(/slot 1/)
    expect(enc([key({ keyType: 1 })])).toThrow(/slot 0/)
    expect(enc([key(), ENC, { ...ENC, keyId: 7 }])).toThrow(/one encryption key/)
    expect(enc([key({ keyType: 2 }), ENC])).not.toThrow()
  })
})

describe('defineProfile', () => {
  const base = { prfLabel: 'a/prf', infoLabel: 'a', aadDocType: 'vaultEntry', entryVersion: 1 as const, strictSealedLength: false }

  it('pins the three profiles', () => {
    expect(sealedLengths(yapprProfile)).toEqual([96, 176])
    expect(sealedLengths(govhubProfile)).toEqual([256])
    expect(sealedLengths(forgeProfile)).toEqual([256])
    expect(Object.isFrozen(forgeProfile)).toBe(true)
  })

  it('refuses duplicate ids, mixed lengths in a strict profile, odd labels and no formats', () => {
    expect(() => defineProfile({ ...base, formats: [yapprRaw, yapprRaw] })).toThrow(/unique/)
    expect(() => defineProfile({ ...base, strictSealedLength: true, formats: [yapprRaw, yapprRing] })).toThrow(/one length/)
    expect(() => defineProfile({ ...base, formats: [] })).toThrow(/at least one/)
    expect(() => defineProfile({ ...base, prfLabel: 'has space', formats: [yapprRaw] })).toThrow(/printable/)
    expect(() => defineProfile({ ...base, infoLabel: 'a/prf', formats: [yapprRaw] })).toThrow(/differ/)
    expect(() => defineProfile({ ...base, entryVersion: 2 as unknown as 1, formats: [yapprRaw] })).toThrow(/version 1/)
    expect(() => seedCodec({ id: 1, length: 37 })).toThrow()
    expect(() => votingKeysCodec({ id: 1, length: 2 + 7 * 32 - 1, maxKeys: 7 })).toThrow()
  })
})
