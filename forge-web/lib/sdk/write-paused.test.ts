/**
 * While the devnet is moving (`NEXT_PUBLIC_DEVNET_NOTICE=moving`) no write signs: `serialized`,
 * which every write runs in, refuses before it queues, whatever reached it past the buttons.
 */

import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ paused: null as string | null }))
vi.mock('../devnet-notice', () => ({ writesPausedReason: () => state.paused }))

import { serialized } from './write'

describe('serialized while the devnet is moving', () => {
  it('runs the write when nothing is paused', async () => {
    state.paused = null
    await expect(serialized('id-free', () => Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('refuses with the reason and never runs the write', async () => {
    state.paused = 'Writing is paused while this devnet moves to a new one — reading still works.'
    const run = vi.fn(() => Promise.resolve('ok'))
    await expect(serialized('id-paused', run)).rejects.toThrow('Writing is paused')
    expect(run).not.toHaveBeenCalled()
  })
})
