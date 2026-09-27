import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StepTimeoutError, withTimeout } from './timeout'

describe('withTimeout', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('rejects a promise that never settles with an error naming the step', async () => {
    const p = withTimeout(new Promise(() => {}), 20_000, 'Connecting to Dash Platform')
    const check = expect(p).rejects.toThrow('Connecting to Dash Platform did not finish within 20 s')
    await vi.advanceTimersByTimeAsync(20_000)
    await check
    await expect(p).rejects.toBeInstanceOf(StepTimeoutError)
  })

  it('passes a value or an error through before the deadline, and clears its timer', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'x')).resolves.toBe(7)
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom')
    expect(vi.getTimerCount()).toBe(0)
  })
})
