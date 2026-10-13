import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Encode } from '@/lib/auth/base58'

const resolve = vi.fn<(sdk: unknown, names: readonly string[], network: string) => Promise<Map<string, string | null>>>()
// a failed read is a plain throw here: a rejecting vi.fn leaves a rejection vitest reports as unhandled
let failRead = false
vi.mock('@/lib/view/dpns', async (orig) => ({
  ...(await orig<typeof import('@/lib/view/dpns')>()),
  resolveDpnsIds: async (...a: Parameters<typeof resolve>) => {
    if (failRead) throw new Error('network down')
    return resolve(...a)
  },
}))

import { NAME_LOOKUP_FAILED, NOT_A_PERSON, parsePersonInput, resolvePerson, unknownName } from './person-input'

const ID = base58Encode(new Uint8Array(32).fill(7))
const sdk = {} as EvoSDK

beforeEach(() => {
  resolve.mockReset()
  failRead = false
})

describe('parsePersonInput', () => {
  it('reads an identity id, with or without an @', () => {
    expect(parsePersonInput(ID)).toEqual({ kind: 'id', id: ID })
    expect(parsePersonInput(`  @${ID} `)).toEqual({ kind: 'id', id: ID })
  })

  it('reads name.dash, @name and a bare label as one name', () => {
    expect(parsePersonInput('alice.dash')).toEqual({ kind: 'name', name: 'alice.dash' })
    expect(parsePersonInput('@alice')).toEqual({ kind: 'name', name: 'alice.dash' })
    expect(parsePersonInput('alice')).toEqual({ kind: 'name', name: 'alice.dash' })
  })

  it('is empty for nothing and invalid for what is neither', () => {
    expect(parsePersonInput('  ')).toEqual({ kind: 'empty' })
    expect(parsePersonInput('@')).toEqual({ kind: 'empty' })
    expect(parsePersonInput('not a name!')).toEqual({ kind: 'invalid', error: NOT_A_PERSON })
    expect(parsePersonInput('a')).toEqual({ kind: 'invalid', error: NOT_A_PERSON })
  })
})

describe('resolvePerson', () => {
  it('returns a typed id without reading anything', async () => {
    expect(await resolvePerson(sdk, 'devnet', ID)).toEqual({ id: ID, name: null })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolves a name to its identity and keeps the name', async () => {
    resolve.mockResolvedValue(new Map([['alice.dash', ID]]))
    expect(await resolvePerson(sdk, 'devnet', '@alice')).toEqual({ id: ID, name: 'alice.dash' })
    expect(resolve).toHaveBeenCalledWith(sdk, ['alice.dash'], 'devnet')
  })

  it('refuses a name nobody holds', async () => {
    resolve.mockResolvedValue(new Map([['nobody.dash', null]]))
    expect(await resolvePerson(sdk, 'devnet', 'nobody.dash')).toEqual({ error: unknownName('nobody.dash') })
  })

  it('does not call a failed read "no such name"', async () => {
    failRead = true
    expect(await resolvePerson(sdk, 'devnet', 'alice.dash')).toEqual({ error: NAME_LOOKUP_FAILED })
  })

  it('refuses what is not a person without reading', async () => {
    expect(await resolvePerson(sdk, 'devnet', 'not a name!')).toEqual({ error: NOT_A_PERSON })
    expect(await resolvePerson(sdk, 'devnet', '')).toEqual({ error: NOT_A_PERSON })
    expect(resolve).not.toHaveBeenCalled()
  })
})
