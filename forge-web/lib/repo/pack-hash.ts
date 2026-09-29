/**
 * `packHash` encodings. RC1 types `chunk.packHash` and `packManifest.packHash` as identifiers
 * (`$defs.hid`: 32 bytes, `contentMediaType` identifier, R-09), so they travel like `repoId`,
 * not like the other 32-byte hashes (`refNameHash` stays a plain byteArray):
 *
 * - a write passes the 32 raw bytes (the same value `decodeIdentifier` gives for an id);
 * - a `where` operand is the **base58** string, not base64 (`lib/sdk/query.ts` rule 1 is for
 *   plain byteArrays);
 * - a read comes back base58 from the 4.2 SDK's `toJSON` (base64 from older serializers, raw
 *   bytes from `toObject`).
 *
 * The web works in lowercase hex (the sha256 of the artifact) and converts only here. Kept out
 * of `packs.ts` so `source.ts`, which `packs.ts` imports, can use it without an import cycle.
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

import { base58Decode, base58Encode } from '../auth/base58'
import { base64ToBytes } from '../sdk'

/** The `where` operand for a `packHash` of `hex` (an identifier: base58). */
export function packHashOperand(hex: string): string {
  return base58Encode(hexToBytes(hex))
}

/**
 * A `packHash` field as lowercase hex, whichever form it arrived in: raw bytes, base58 (an
 * identifier from `toJSON`), base64 (a byteArray from an older SDK, or a pre-RC1 fixture) or hex.
 * Base58 is tried before base64: a 43-character base58 string also decodes as unpadded base64,
 * while a 32-byte base64 value always ends in `=`, which base58 lacks. `''` when absent;
 * an undecodable string is returned unchanged (it then matches no real hash).
 */
export function packHashHex(v: unknown): string {
  if (v instanceof Uint8Array) return bytesToHex(v)
  if (typeof v !== 'string' || v === '') return ''
  if (/^[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase()
  try {
    const b = base58Decode(v)
    if (b.length === 32) return bytesToHex(b)
  } catch {
    /* not base58 */
  }
  try {
    return bytesToHex(base64ToBytes(v))
  } catch {
    return v
  }
}
