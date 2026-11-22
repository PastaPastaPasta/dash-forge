import { describe, expect, it } from 'vitest'

import { setWritePhase, subscribeWriteProgress, trackWrite, writeProgress } from './write-progress'

describe('write progress', () => {
  it('reports a write from sending through its phases, and nothing once it settles', async () => {
    const seen: (string | null)[] = []
    const stop = subscribeWriteProgress(() => seen.push(writeProgress()?.phase ?? null))
    setWritePhase('confirming')
    expect(writeProgress()).toBeNull()
    await trackWrite(async () => {
      setWritePhase('confirming')
      setWritePhase('confirming')
      setWritePhase('rechecking')
    })
    stop()
    expect(seen).toEqual(['sending', 'confirming', 'rechecking', null])
  })

  it('ends the report of a write that throws', async () => {
    await expect(trackWrite(async () => Promise.reject(new Error('refused')))).rejects.toThrow('refused')
    expect(writeProgress()).toBeNull()
  })

  it('keeps the start time across phases', async () => {
    await trackWrite(async () => {
      const startedAt = writeProgress()!.startedAt
      setWritePhase('confirming')
      expect(writeProgress()).toEqual({ phase: 'confirming', startedAt })
    })
  })
})
