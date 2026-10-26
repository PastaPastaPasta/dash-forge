import { describe, expect, it } from 'vitest'
import { decodeBase58, decodeIdentityId, deriveSharedSecret, encodeBase58, getPublicKey, hash160 } from './primitives'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

const text = (value: string) => new TextEncoder().encode(value)

describe('base58', () => {
  const cases: Array<[string, string]> = [
    ['', ''],
    ['00', '1'],
    ['0000', '11'],
    ['61', '2g'],
    ['00000001', '1112'],
    [bytesToHex(text('Hello World!')), '2NEpo7TZRRrLZSi2U'],
    ['00eb15231dfceb60925886b67d065299925915aeb172c06647', '1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L'],
  ]

  it('matches known Bitcoin-alphabet vectors both ways', () => {
    for (const [hex, base58] of cases) {
      expect(encodeBase58(hexToBytes(hex))).toBe(base58)
      expect(bytesToHex(decodeBase58(base58))).toBe(hex)
    }
  })

  it('round-trips identity ids with and without a leading zero byte', () => {
    for (const first of [0, 1, 0x80, 0xff]) {
      const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? first : (i * 37) & 0xff))
      expect(decodeBase58(encodeBase58(bytes))).toEqual(bytes)
    }
  })

  it('rejects characters outside the alphabet', () => {
    for (const bad of ['0', 'O', 'I', 'l', 'ab c', '+/']) expect(() => decodeBase58(bad)).toThrow()
  })
})

describe('decodeIdentityId', () => {
  it('requires exactly 32 bytes', () => {
    const id = 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7'
    expect(decodeIdentityId(id)).toHaveLength(32)
    expect(() => decodeIdentityId(encodeBase58(new Uint8Array(31).fill(1)))).toThrow(/expected 32, got 31/)
  })
})

describe('hash160 and ECDH', () => {
  it('hash160 of the empty input is the well-known RIPEMD160(SHA256(""))', () => {
    expect(bytesToHex(hash160(new Uint8Array(0)))).toBe('b472a266d0bd89c13706a4132ccfb16f7c3b9fcb')
  })

  it('derives the same secret from either side and separates by info', () => {
    const a = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
    const b = Uint8Array.from({ length: 32 }, (_, i) => 100 + i)
    const ab = deriveSharedSecret(a, getPublicKey(b), text('app-connect:v2'))
    const ba = deriveSharedSecret(b, getPublicKey(a), text('app-connect:v2'))
    expect(ab).toEqual(ba)
    expect(ab).not.toEqual(deriveSharedSecret(a, getPublicKey(b)))
  })
})
