import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { CID_CHUNK_SIZE, cidV1RawLeaves, isCid, normalizeCid, sameCid } from './cid'

describe('cidV1RawLeaves (parity with forge-core backends/cid.rs)', () => {
  it('derives the well-known empty raw block', () => {
    expect(cidV1RawLeaves(new Uint8Array(0))).toBe('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku')
  })

  it('derives a single raw leaf', () => {
    expect(cidV1RawLeaves(new TextEncoder().encode('hello'))).toBe('bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq')
  })

  it('makes a dag-pb root past one chunk, deterministically', () => {
    const data = new Uint8Array(CID_CHUNK_SIZE + 1).fill(7)
    const cid = cidV1RawLeaves(data)
    expect(cid.startsWith('bafybei')).toBe(true)
    expect(cidV1RawLeaves(data)).toBe(cid)
    // What `ipfs add --only-hash` returns for these bytes under the pinned parameters.
    expect(cid).toBe('bafybeihldj5jykexbnvf5jx3cm2pjlqqa3hwyc5d6wo2y7ujlk7qjjgzlu')
  })

  it('recognizes CIDs and refuses path smuggling', () => {
    expect(isCid('bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq')).toBe(true)
    expect(isCid('bafy/../../api')).toBe(false)
    expect(isCid('')).toBe(false)
  })
})


it('preserves CIDv0 and normalizes base58btc, base36 and uppercase base32 to CIDv1 base32', () => {
  const raw = Uint8Array.from([1, 0x70, 0x12, 32, ...new Uint8Array(32).fill(1)])
  const v0 = base58Encode(raw.slice(2))
  const expected = normalizeCid('z' + base58Encode(raw))
  expect(expected).toMatch(/^bafy/)
  expect(normalizeCid(v0)).toBe(v0)
  expect(sameCid(v0, expected!)).toBe(true)
  expect(normalizeCid(expected!.toUpperCase())).toBe(expected)
  let n = 0n
  for (const byte of raw) n = n * 256n + BigInt(byte)
  expect(normalizeCid('k' + n.toString(36))).toBe(expected)
  expect(normalizeCid('k0' + n.toString(36))).toBeNull()
  expect(normalizeCid('f' + Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join(''))).toBeNull()
})
it.each(['junk', 'bafkreia', 'b!!!!', 'z0', 'f01701220', 'k0', 'b' + 'a'.repeat(10000)])('rejects invalid or truncated CIDs', (value) => {
  expect(normalizeCid(value)).toBeNull()
})
