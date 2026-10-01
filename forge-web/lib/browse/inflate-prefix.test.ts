/**
 * `inflatePrefix`: the first bytes of a zlib stream, for telling a blob too large to read whole
 * binary by its first 8,000 bytes as git does (QW3-045), without inflating the rest.
 */

import { zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { inflatePrefix } from './pack'

describe('inflatePrefix', () => {
  const data = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7919) % 251)
  const stream = zlibSync(data)

  it('gives the first bytes of a stream', () => {
    expect(inflatePrefix(stream, 0, 8000)).toEqual(data.subarray(0, 8000))
  })

  it('works on a stream cut short (only a prefix of the entry was fetched)', () => {
    const cut = stream.subarray(0, 4000)
    const out = inflatePrefix(cut, 0, 8000)
    expect(out.length).toBeGreaterThan(0)
    expect(out).toEqual(data.subarray(0, out.length))
  })

  it('returns what a short stream holds', () => {
    expect(inflatePrefix(zlibSync(Uint8Array.of(1, 2, 3)), 0, 8000)).toEqual(Uint8Array.of(1, 2, 3))
  })

  it('returns at once when nothing is wanted (pako would loop on a zero-byte chunk)', () => {
    expect(inflatePrefix(stream, 0, 0)).toEqual(new Uint8Array(0))
    expect(inflatePrefix(stream, 0, -1)).toEqual(new Uint8Array(0))
  })
})
