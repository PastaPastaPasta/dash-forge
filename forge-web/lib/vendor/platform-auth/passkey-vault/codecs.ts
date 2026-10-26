// Bundle codecs: the plaintext an entry seals. A codec owns one format byte and one padded length; the profile lists the codecs a
// vault accepts. Every codec writes `format u8` first, pads with zeros to its length, and refuses non-zero padding on decode.
//
// slotKeysCodec is Yappr's slot layout (formats 1 and 2) and, with maxKeys 1, govhub's KEY format:
//   format u8 ‖ n u8 ‖ n × (purpose u8 ‖ securityLevel u8 ‖ keyType u8 ‖ keyId u32be ‖ privateKey[32]) ‖ zero padding
// seedCodec and votingKeysCodec are govhub's SEED and VOTING_KEYS formats.
import { isU32, readU32be, u32be, wipe, zeroFrom } from './bytes'
import { need, VaultCryptoError } from './errors'

export interface BundleCodec<B> {
  /** The format byte (byte 0 of the plaintext). */
  readonly id: number
  /** The padded plaintext length (the sealed length is this + 16). */
  readonly length: number
  encode(bundle: B): Uint8Array
  /** Decodes and checks a plaintext of exactly `length` bytes; refuses a bundle that does not belong to entry key id `authKeyId`. */
  decode(bytes: Uint8Array, authKeyId: number): B
  /** The entry key id a bundle implies (slot 0's key id), when the format has one. */
  authKeyIdOf?(bundle: B): number
  /** Overwrites every secret in the bundle. */
  wipe(bundle: B): void
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/** A 32-byte secp256k1 private key in [1, n). */
export function isValidPrivateKey(sk: Uint8Array): boolean {
  if (sk.length !== 32) return false
  let v = 0n
  for (const b of sk) v = (v << 8n) | BigInt(b)
  return v > 0n && v < SECP256K1_N
}

function checkCodecShape(id: number, length: number, minLength: number): void {
  need(Number.isInteger(id) && id >= 1 && id <= 255, 'a codec id must be 1 to 255')
  need(Number.isInteger(length) && length >= minLength && length <= 4096, `a codec of this layout needs at least ${minLength} bytes`)
}

function checkMaxKeys(maxKeys: number): void {
  need(Number.isInteger(maxKeys) && maxKeys >= 1 && maxKeys <= 255, 'maxKeys must be 1 to 255')
}

function checkPadding(bytes: Uint8Array, used: number): void {
  need(zeroFrom(bytes, used), "the bundle's padding is not zero", 'bundle')
}

function checkHeader(bytes: Uint8Array, id: number, length: number): void {
  need(bytes.length === length && bytes[0] === id, 'the bundle does not match its format', 'format')
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Slot keys
// ---------------------------------------------------------------------------------------------------------------------------------

export const SLOT_LENGTH = 39

export interface SlotKey {
  purpose: number
  securityLevel: number
  keyType: number
  keyId: number
  /** 32-byte secp256k1 private key (ECDSA_SECP256K1 or ECDSA_HASH160 identity keys). */
  privateKey: Uint8Array
}

export interface SlotBundle {
  format: number
  /** Slot 0 is the entry's key (`authKeyId`). */
  keys: SlotKey[]
}

export interface SlotKeysCodecOptions {
  id: number
  length: number
  maxKeys: number
  /** Whether `slotIndex` of a bundle of format `format` may hold `key`. Called on encode and on decode. */
  allow(key: Readonly<Omit<SlotKey, 'privateKey'>>, slotIndex: number, format: number): boolean
  /** A whole-bundle rule (say, one encryption key at most): a reason to refuse, or null. Called on encode and on decode. */
  check?(keys: readonly Readonly<Omit<SlotKey, 'privateKey'>>[]): string | null
}

export function slotKeysCodec(o: SlotKeysCodecOptions): BundleCodec<SlotBundle> {
  checkMaxKeys(o.maxKeys)
  checkCodecShape(o.id, o.length, 2 + o.maxKeys * SLOT_LENGTH)
  const { id, length, maxKeys } = o

  const checkKeys = (keys: readonly SlotKey[]): void => {
    need(keys.length >= 1 && keys.length <= maxKeys, `a bundle of this format holds 1 to ${maxKeys} keys`, 'bundle')
    keys.forEach((key, index) => {
      need(isU32(key.keyId), 'a key id is out of range', 'bundle')
      need(key.privateKey.length === 32, 'a private key must be 32 bytes', 'bundle')
      need(
        o.allow({ purpose: key.purpose, securityLevel: key.securityLevel, keyType: key.keyType, keyId: key.keyId }, index, id),
        `slot ${index} may not hold a key of purpose ${key.purpose} at level ${key.securityLevel} of type ${key.keyType}`,
        'bundle',
      )
      need(isValidPrivateKey(key.privateKey), 'a private key is not a valid secp256k1 key', 'bundle')
    })
    need(new Set(keys.map((key) => key.keyId)).size === keys.length, 'a key appears twice', 'bundle')
    const reason = o.check?.(keys)
    if (reason) throw new VaultCryptoError(reason, 'bundle')
  }

  return {
    id,
    length,
    encode(bundle) {
      need(bundle.format === id, 'the bundle is not of this format')
      checkKeys(bundle.keys)
      const out = new Uint8Array(length)
      out[0] = id
      out[1] = bundle.keys.length
      bundle.keys.forEach((key, index) => {
        const offset = 2 + index * SLOT_LENGTH
        out.set([key.purpose, key.securityLevel, key.keyType], offset)
        out.set(u32be(key.keyId), offset + 3)
        out.set(key.privateKey, offset + 7)
      })
      return out
    },
    decode(bytes, authKeyId) {
      checkHeader(bytes, id, length)
      const count = bytes[1] ?? 0
      need(count >= 1 && count <= maxKeys, "the bundle's key count is out of range", 'bundle')
      const keys: SlotKey[] = []
      for (let index = 0; index < count; index += 1) {
        const offset = 2 + index * SLOT_LENGTH
        keys.push({
          purpose: bytes[offset] ?? 0,
          securityLevel: bytes[offset + 1] ?? 0,
          keyType: bytes[offset + 2] ?? 0,
          keyId: readU32be(bytes, offset + 3),
          privateKey: bytes.slice(offset + 7, offset + SLOT_LENGTH),
        })
      }
      try {
        checkKeys(keys)
        checkPadding(bytes, 2 + count * SLOT_LENGTH)
        need(keys[0]?.keyId === authKeyId, "slot 0 is not the entry's key", 'bundle')
      } catch (error) {
        for (const key of keys) wipe(key.privateKey)
        throw error
      }
      return { format: id, keys }
    },
    authKeyIdOf: (bundle) => {
      const first = bundle.keys[0]
      need(first !== undefined, 'the bundle holds no key', 'bundle')
      return first.keyId
    },
    wipe: (bundle) => {
      for (const key of bundle.keys) wipe(key.privateKey)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Seed (govhub SEED): format u8 ‖ len u8 ‖ identityIndex u32be ‖ entropy[len] ‖ zero padding
// ---------------------------------------------------------------------------------------------------------------------------------

export interface SeedBundle {
  format: number
  /** DIP-13 identity index, below 2^31. */
  identityIndex: number
  /** BIP39 entropy, 16 or 32 bytes. */
  entropy: Uint8Array
}

export function seedCodec(o: { id: number; length: number }): BundleCodec<SeedBundle> {
  checkCodecShape(o.id, o.length, 6 + 32)
  const { id, length } = o
  const checkFields = (identityIndex: number, entropyLength: number): void => {
    need(entropyLength === 16 || entropyLength === 32, 'seed entropy must be 16 or 32 bytes', 'bundle')
    need(isU32(identityIndex) && identityIndex < 0x80000000, 'identity index out of range', 'bundle')
  }
  return {
    id,
    length,
    encode(bundle) {
      need(bundle.format === id, 'the bundle is not of this format')
      checkFields(bundle.identityIndex, bundle.entropy.length)
      const out = new Uint8Array(length)
      out[0] = id
      out[1] = bundle.entropy.length
      out.set(u32be(bundle.identityIndex), 2)
      out.set(bundle.entropy, 6)
      return out
    },
    decode(bytes) {
      checkHeader(bytes, id, length)
      const entropyLength = bytes[1] ?? 0
      const identityIndex = readU32be(bytes, 2)
      checkFields(identityIndex, entropyLength)
      checkPadding(bytes, 6 + entropyLength)
      return { format: id, identityIndex, entropy: bytes.slice(6, 6 + entropyLength) }
    },
    wipe: (bundle) => wipe(bundle.entropy),
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Voting keys (govhub VOTING_KEYS): format u8 ‖ n u8 ‖ n × privateKey[32] ‖ zero padding
// ---------------------------------------------------------------------------------------------------------------------------------

export interface VotingKeysBundle {
  format: number
  keys: Uint8Array[]
}

export function votingKeysCodec(o: { id: number; length: number; maxKeys: number }): BundleCodec<VotingKeysBundle> {
  checkMaxKeys(o.maxKeys)
  checkCodecShape(o.id, o.length, 2 + o.maxKeys * 32)
  const { id, length, maxKeys } = o
  const checkKeys = (keys: readonly Uint8Array[]): void => {
    need(keys.length >= 1 && keys.length <= maxKeys, `a voting-key bundle holds 1 to ${maxKeys} keys`, 'bundle')
    need(keys.every(isValidPrivateKey), 'invalid voting key', 'bundle')
    need(new Set(keys.map((k) => k.join(','))).size === keys.length, 'a voting key appears twice', 'bundle')
  }
  return {
    id,
    length,
    encode(bundle) {
      need(bundle.format === id, 'the bundle is not of this format')
      checkKeys(bundle.keys)
      const out = new Uint8Array(length)
      out[0] = id
      out[1] = bundle.keys.length
      bundle.keys.forEach((k, i) => out.set(k, 2 + i * 32))
      return out
    },
    decode(bytes) {
      checkHeader(bytes, id, length)
      const count = bytes[1] ?? 0
      need(count >= 1 && count <= maxKeys, 'voting key count out of range', 'bundle')
      const keys = Array.from({ length: count }, (_, i) => bytes.slice(2 + i * 32, 34 + i * 32))
      try {
        checkKeys(keys)
        checkPadding(bytes, 2 + count * 32)
      } catch (error) {
        wipe(...keys)
        throw error
      }
      return { format: id, keys }
    },
    wipe: (bundle) => wipe(...bundle.keys),
  }
}
