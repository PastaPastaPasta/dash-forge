import * as secp256k1 from '@noble/secp256k1'
import { hkdf } from '@noble/hashes/hkdf.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'

/**
 * The small set of primitives the App Connect module needs, kept here so the
 * module depends only on `@noble/hashes` and `@noble/secp256k1` and can be
 * vendored on its own. These are internal: `index.ts` re-exports only the
 * `AppConnectNetworkName` type, because names like `hash160` would clash with
 * the key-exchange module in the package root.
 */

/** The one-letter network id carried in the `n=` parameter of an App Connect URI. */
export const APP_CONNECT_NETWORK_IDS = {
  mainnet: 'm',
  testnet: 't',
  devnet: 'd',
} as const

export type AppConnectNetworkName = keyof typeof APP_CONNECT_NETWORK_IDS

const encoder = new TextEncoder()
const NO_HKDF_INFO = new Uint8Array(0)

export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data))
}

/**
 * ECDH x-coordinate then HKDF-SHA256 (salt `dash:key-exchange:v1`). ECDH is
 * symmetric, so the wallet calls this with its private key and the app's
 * public key. The legacy key exchange uses an empty `info`; App Connect v2
 * passes `app-connect:v2`. Intermediate buffers are zeroed before returning.
 */
export function deriveSharedSecret(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  info: Uint8Array = NO_HKDF_INFO,
): Uint8Array {
  const sharedPoint = secp256k1.getSharedSecret(privateKey, publicKey)
  const sharedX = sharedPoint.slice(1, 33)
  try {
    return hkdf(sha256, sharedX, encoder.encode('dash:key-exchange:v1'), info, 32)
  } finally {
    sharedX.fill(0)
    sharedPoint.fill(0)
  }
}

export function getPublicKey(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, true)
}

export function clearSensitiveBytes(bytes: Uint8Array): void {
  bytes.fill(0)
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE58_INDEX: Record<string, number> = Object.fromEntries(
  Array.from(BASE58_ALPHABET, (char, index) => [char, index]),
)

/** Base58 (Bitcoin alphabet) encoding; each leading zero byte becomes a leading `1`. */
export function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  // Little-endian base-58 digits of the remaining big-endian number.
  const digits: number[] = []
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] ?? 0
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] ?? 0) << 8
      digits[j] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let out = '1'.repeat(zeros)
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET.charAt(digits[i] ?? 0)
  return out
}

/** Inverse of {@link encodeBase58}; throws on any character outside the alphabet. */
export function decodeBase58(text: string): Uint8Array {
  let zeros = 0
  while (zeros < text.length && text.charAt(zeros) === '1') zeros++
  // Little-endian bytes of the remaining base-58 number.
  const bytes: number[] = []
  for (let i = zeros; i < text.length; i++) {
    const value = BASE58_INDEX[text.charAt(i)]
    if (value === undefined) throw new Error('Non-base58 character')
    let carry = value
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] ?? 0) * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  const out = new Uint8Array(zeros + bytes.length)
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i] ?? 0
  return out
}

export function decodeIdentityId(identityIdBase58: string): Uint8Array {
  const decoded = decodeBase58(identityIdBase58)
  if (decoded.length !== 32) {
    throw new Error(`Invalid identity ID length: expected 32, got ${decoded.length}`)
  }
  return decoded
}
