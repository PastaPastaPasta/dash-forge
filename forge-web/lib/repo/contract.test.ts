import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { asIdentifierString } from './contract'

describe('asIdentifierString', () => {
  it('normalizes a base64 byteArray identifier to Platform base58', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
    const base64 = Buffer.from(bytes).toString('base64')

    expect(asIdentifierString(base64)).toBe(base58Encode(bytes))
  })

  it('leaves an existing base58 identifier unchanged', () => {
    const value = base58Encode(new Uint8Array(32).fill(7))
    expect(asIdentifierString(value)).toBe(value)
  })
})
