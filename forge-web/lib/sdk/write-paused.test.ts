/**
 * While the devnet is moving (`NEXT_PUBLIC_DEVNET_NOTICE=moving`) nothing is broadcast:
 * `assertWritesAllowed` refuses at each broadcast point (document writes, paid identity updates,
 * identity creation and top-up). The writer queue itself (`serialized`) is not refused: it also
 * carries local-only work (storing a wallet's keys) that must still finish.
 */

import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ paused: null as string | null }))
vi.mock('../devnet-notice', () => ({ writesPausedReason: () => state.paused }))

import { WritesPausedError, assertWritesAllowed, createDocumentIdempotent, serialized, type WriteAuth } from './write'

const REASON = 'Writing is paused while this devnet moves to a new one — reading still works.'

describe('assertWritesAllowed', () => {
  it('passes when nothing is paused', () => {
    state.paused = null
    expect(() => assertWritesAllowed()).not.toThrow()
  })

  it('throws a WritesPausedError carrying the reason while paused', () => {
    state.paused = REASON
    expect(() => assertWritesAllowed()).toThrow(WritesPausedError)
    expect(() => assertWritesAllowed()).toThrow('Writing is paused')
  })
})

describe('while the devnet is moving', () => {
  it('a document write is refused before anything is signed', async () => {
    state.paused = REASON
    const sdk = {} as never
    const auth = { identityId: 'id-paused' } as unknown as WriteAuth
    await expect(createDocumentIdempotent(sdk, auth, {} as never)).rejects.toThrow(WritesPausedError)
  })

  it('the writer queue still runs local-only work', async () => {
    state.paused = REASON
    await expect(serialized('id-local', () => Promise.resolve('stored'))).resolves.toBe('stored')
  })
})
