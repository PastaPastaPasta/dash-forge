import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

export { bytesToHex as hex, hexToBytes as unhex, utf8ToBytes as utf8 }

export type Json = null | boolean | number | string | bigint | readonly Json[] | { readonly [k: string]: Json | undefined }

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return JSON.stringify(value.toString())
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`non-integer number in canonical JSON: ${value}`)
    if (value === undefined) throw new Error('undefined in canonical JSON')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const o = value as Record<string, unknown>
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}

export const sha256hex = (data: string | Uint8Array): string => bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data))

export const digest = (value: unknown): string => sha256hex(canonical(value))

export function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, false)
  return b
}

export function lengthPrefixed(...parts: readonly (string | number | Uint8Array)[]): Uint8Array {
  return concatBytes(
    ...parts.flatMap((p) => {
      const bytes = typeof p === 'string' ? utf8ToBytes(p) : typeof p === 'number' ? u32be(p) : p
      return [u32be(bytes.length), bytes]
    }),
  )
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message)
}

export function getOwn<T>(o: Readonly<Record<string, T>>, k: unknown): T | null {
  return typeof k === 'string' && Object.hasOwn(o, k) ? (o[k] as T) : null
}

export const isHex = (s: unknown, bytes?: number): s is string =>
  typeof s === 'string' && /^[0-9a-f]*$/.test(s) && s.length % 2 === 0 && (bytes === undefined || s.length === bytes * 2)

export const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

export const ROOM_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

export function memo<A extends unknown[], R>(fn: (...args: A) => R, keyOf: (...args: A) => string, limit = 5000): (...args: A) => R {
  const cache = new Map<string, R>()
  return (...args: A): R => {
    const key = keyOf(...args)
    if (cache.has(key)) return cache.get(key) as R
    const value = fn(...args)
    if (cache.size >= limit) cache.delete(cache.keys().next().value as string)
    cache.set(key, value)
    return value
  }
}

const comparable = (v: unknown): unknown =>
  v instanceof Uint8Array
    ? `0x${bytesToHex(v)}`
    : typeof v === 'bigint' || typeof v === 'number'
      ? String(v)
      : Array.isArray(v)
        ? v.map(comparable)
        : isObject(v)
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, comparable(v[k])]),
            )
          : v

/** Equal by value: bytes by content, integers whatever their width. */
export const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(comparable(a)) === JSON.stringify(comparable(b))

/** Whether two documents carry the same fields, system (`$`) fields aside. */
export function sameFields(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !k.startsWith('$')))
  return [...keys].every((k) => sameValue(a[k], b[k]))
}
