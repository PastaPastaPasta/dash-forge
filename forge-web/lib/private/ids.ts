/**
 * Identities and document ids in the private layer are the raw 32 bytes, compared as bytes
 * (`docs/security/private-repos.md` §5.3: anchors order by `($createdAtBlockHeight, $id)` with
 * `$id` as raw bytes; base58 or hex string order would disagree). Convert at the boundary with
 * {@link privateId} and {@link encodePrivateId}.
 */

import { base58Encode, decodeIdentifier } from '../auth/base58'
import { bytesToHex, hexToBytes, type Bytes } from './bytes'

/** A 32-byte identity or document id. */
export type PrivateId = Uint8Array

export type IdEncoding = 'hex' | 'base58'

const HEX_ID = /^[0-9a-fA-F]{64}$/

/** Decode an identity or id given as 64 hex characters or base58 (Platform's form). */
export function privateId(x: string): Bytes {
  if (HEX_ID.test(x)) return hexToBytes(x)
  return new Uint8Array(decodeIdentifier(x))
}

/** Encode an identity or id for display or an API. */
export function encodePrivateId(id: Uint8Array, encoding: IdEncoding = 'hex'): string {
  return encoding === 'base58' ? base58Encode(id) : bytesToHex(id)
}

/** Lexicographic byte order (a proper prefix first). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number)
    if (d !== 0) return d
  }
  return a.length - b.length
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return compareBytes(a, b) === 0
}

/** A set of ids (hex internally; bytes in and out). */
export class IdSet {
  private readonly hex = new Map<string, Uint8Array>()

  constructor(ids: Iterable<Uint8Array> = []) {
    for (const id of ids) this.add(id)
  }

  add(id: Uint8Array): void {
    this.hex.set(bytesToHex(id), id)
  }

  has(id: Uint8Array): boolean {
    return this.hex.has(bytesToHex(id))
  }

  get size(): number {
    return this.hex.size
  }

  /** The ids in byte order. */
  sorted(): Uint8Array[] {
    return [...this.hex.values()].sort(compareBytes)
  }
}
