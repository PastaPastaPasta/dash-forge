/**
 * Byte helpers for the private-repository crypto core (`docs/security/private-repos.md`).
 * All integers are big-endian. `Bytes` is a `Uint8Array` over a plain `ArrayBuffer`, the
 * type WebCrypto accepts as a `BufferSource`.
 */

export type Bytes = Uint8Array<ArrayBuffer>

/** `u` itself when it is over a plain `ArrayBuffer`, otherwise a copy. */
export function bytes(u: Uint8Array): Bytes {
  return u.buffer instanceof ArrayBuffer ? (u as Bytes) : new Uint8Array(u)
}

const HEX = /^(?:[0-9a-fA-F]{2})*$/

/** Decode hex (either case); throws on odd length or a non-hex character. */
export function hexToBytes(hex: string): Bytes {
  if (!HEX.test(hex)) throw new TypeError('invalid hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16)
  return out
}

/** Lowercase hex. */
export function bytesToHex(u: Uint8Array): string {
  let s = ''
  for (const b of u) s += b.toString(16).padStart(2, '0')
  return s
}

export function concat(...parts: readonly Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function isU32(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 0xffff_ffff
}

export function u16(n: number): Bytes {
  const out = new Uint8Array(2)
  new DataView(out.buffer).setUint16(0, n)
  return out
}

export function u32(n: number): Bytes {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n)
  return out
}

export function u64(n: number): Bytes {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n))
  return out
}

/** Whether `a` and `b` are equal, in time independent of where they differ. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export function utf8(s: string): Bytes {
  return new TextEncoder().encode(s)
}

export async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(data)))
}

/** `n` bytes from the platform CSPRNG. */
export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n))
}

/** Best-effort erasure of transient key material. */
export function wipe(u: Uint8Array): void {
  u.fill(0)
}
