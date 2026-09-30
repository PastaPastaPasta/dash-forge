/**
 * `packHash` as an RC1 identifier: every form a reader can meet decodes to the same hex, and a
 * query operand is base58.
 */

import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { bytesToBase64 } from '../sdk'
import { packHashHex, packHashOperand } from './pack-hash'

describe('packHash encodings', () => {
  // Leading zero bytes exercise base58's '1' padding.
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i < 2 ? 0 : i * 7))
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

  it('reads base58 (4.2 toJSON), base64 (older), raw bytes and hex alike', () => {
    expect(packHashHex(base58Encode(bytes))).toBe(hex)
    expect(packHashHex(bytesToBase64(bytes))).toBe(hex)
    expect(packHashHex(bytes)).toBe(hex)
    expect(packHashHex(hex.toUpperCase())).toBe(hex)
    expect(packHashHex(undefined)).toBe('')
    expect(packHashHex('')).toBe('')
  })

  it('reads a 43-character base58 hash as base58, not as unpadded base64', () => {
    const small = new Uint8Array(32).fill(1)
    const b58 = base58Encode(small)
    expect(b58).toHaveLength(43)
    expect(packHashHex(b58)).toBe('01'.repeat(32))
  })

  it('queries with the base58 identifier', () => {
    expect(packHashOperand(hex)).toBe(base58Encode(bytes))
  })
})
