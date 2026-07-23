/**
 * Minimal base58 / base58check — pure JS on top of `@noble/hashes` (already a dependency).
 *
 * Used by the auth layer to decode WIF private keys and to turn base58 identity/document ids
 * into the raw 32-byte form a typed `Document`'s identifier-typed properties expect (parity
 * with forge-core's `platform::decode_identifier`, which is `bs58::decode`). Keeping this
 * dependency-free avoids pulling `bs58` / `bs58check` into the static bundle.
 */

import { sha256 } from '@noble/hashes/sha2.js'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE = 58n

const INDEX: Readonly<Record<string, number>> = (() => {
  const map: Record<string, number> = {}
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET[i] as string] = i
  return map
})()

/** Encode raw bytes as a base58 string. */
export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  let num = 0n
  for (const b of bytes) num = num * 256n + BigInt(b)
  let out = ''
  while (num > 0n) {
    const rem = Number(num % BASE)
    num /= BASE
    out = (ALPHABET[rem] as string) + out
  }
  // Preserve leading zero bytes as leading '1's.
  for (const b of bytes) {
    if (b === 0) out = '1' + out
    else break
  }
  return out
}

/** Decode a base58 string to raw bytes. Throws on an invalid character. */
export function base58Decode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0)
  let num = 0n
  for (const ch of str) {
    const val = INDEX[ch]
    if (val === undefined) throw new Error(`invalid base58 character: ${ch}`)
    num = num * BASE + BigInt(val)
  }
  const bytes: number[] = []
  while (num > 0n) {
    bytes.unshift(Number(num % 256n))
    num /= 256n
  }
  // Restore leading '1' → 0x00 bytes.
  for (const ch of str) {
    if (ch === '1') bytes.unshift(0)
    else break
  }
  return Uint8Array.from(bytes)
}

/** Double-SHA256, the Bitcoin/Dash base58check checksum primitive. */
function sha256d(data: Uint8Array): Uint8Array {
  return sha256(sha256(data))
}

/** Decode a base58check string, validating and stripping the 4-byte checksum. */
export function base58CheckDecode(str: string): Uint8Array {
  const full = base58Decode(str)
  if (full.length < 4) throw new Error('base58check payload too short')
  const payload = full.slice(0, full.length - 4)
  const checksum = full.slice(full.length - 4)
  const expected = sha256d(payload).slice(0, 4)
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) throw new Error('base58check checksum mismatch')
  }
  return payload
}

/** Encode a payload as base58check (appends the 4-byte double-SHA256 checksum). */
export function base58CheckEncode(payload: Uint8Array): string {
  const checksum = sha256d(payload).slice(0, 4)
  const full = new Uint8Array(payload.length + 4)
  full.set(payload, 0)
  full.set(checksum, payload.length)
  return base58Encode(full)
}

/**
 * Decode a base58 identity/document id into its raw 32-byte form — the encoding a typed
 * `Document`'s identifier-typed property (e.g. `targetId`, `listingId`, `repoContractId`)
 * must carry. Throws if the decoded value is not 32 bytes.
 */
export function decodeIdentifier(id: string): Uint8Array {
  const bytes = base58Decode(id)
  if (bytes.length !== 32) {
    throw new Error(`identifier must decode to 32 bytes, got ${bytes.length} (${id})`)
  }
  return bytes
}
