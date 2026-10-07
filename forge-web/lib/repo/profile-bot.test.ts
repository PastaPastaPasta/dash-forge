import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { botClaimOf, profileFromDoc } from './profile'

const id = (b: number): Uint8Array => new Uint8Array(32).fill(b)

describe('profile.bot', () => {
  it('reads an operator and the bots it operates, as bytes or base58', () => {
    const doc = { $id: 'p', $ownerId: 'o', $revision: 1, bot: { operator: id(1), operates: [base58Encode(id(2)), id(3)] } }
    expect(botClaimOf(doc)).toEqual({ operator: base58Encode(id(1)), operates: [base58Encode(id(2)), base58Encode(id(3))] })
    expect(profileFromDoc(doc).bot?.operator).toBe(base58Encode(id(1)))
  })

  it('skips what is not an identifier, and an empty claim is none', () => {
    expect(botClaimOf({ bot: { operator: new Uint8Array(3), operates: ['nope'] } })).toBeUndefined()
    expect(botClaimOf({})).toBeUndefined()
    expect(profileFromDoc({ $id: 'p', $ownerId: 'o', $revision: 1 }).bot).toBeUndefined()
  })
})
