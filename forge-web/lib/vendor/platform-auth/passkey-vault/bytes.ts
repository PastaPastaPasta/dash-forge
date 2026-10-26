// Byte helpers for the passkey vault. Self-contained so the module can be vendored without the rest of platform-auth.

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const p of parts) length += p.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** Equal length and contents. Runs over the whole input whatever the first difference (the inputs are public here). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export const isU32 = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 0xffffffff

export function u32be(value: number): Uint8Array {
  if (!isU32(value)) throw new RangeError('u32 out of range')
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
}

export function readU32be(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) throw new RangeError('read past the end')
  return (((bytes[offset] ?? 0) << 24) >>> 0) + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0)
}

/** Overwrites secret bytes. Best effort: copies made by libraries and the engine are out of reach. */
export function wipe(...arrays: ReadonlyArray<Uint8Array | null | undefined>): void {
  for (const a of arrays) a?.fill(0)
}

/** Cryptographically secure random bytes (Web Crypto). */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

/** True when every byte from `from` to the end is zero. */
export const zeroFrom = (bytes: Uint8Array, from: number): boolean => bytes.subarray(from).every((b) => b === 0)
