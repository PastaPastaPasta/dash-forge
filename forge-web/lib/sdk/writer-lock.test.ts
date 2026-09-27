import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WriterBusyError, serialized } from './write'

/**
 * The per-identity writer lock: a write stuck while holding it must not make every later write
 * for the identity wait forever (owner report: "Sign & create" spun with no broadcast).
 */
describe('serialized writer lock', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('a waiter behind a stuck write in this tab fails with WriterBusyError and never runs', async () => {
    serialized('id-a', () => new Promise(() => {}))
    const second = vi.fn(async () => 'ran')
    const p = serialized('id-a', second, 1_000)
    const check = expect(p).rejects.toBeInstanceOf(WriterBusyError)
    await vi.advanceTimersByTimeAsync(1_000)
    await check
    expect(second).not.toHaveBeenCalled()
  })

  it('a waiter behind a stuck write in another tab (Web Lock) gives up and aborts its lock request', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal('navigator', {
      locks: {
        request: (_name: string, opts: { signal?: AbortSignal }, _cb: () => Promise<unknown>) =>
          new Promise((_, reject) => {
            signal = opts.signal
            opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
          }),
      },
    })
    const run = vi.fn(async () => 'ran')
    const p = serialized('id-b', run, 1_000)
    const check = expect(p).rejects.toThrow(/Another Dash Forge tab/)
    await vi.advanceTimersByTimeAsync(1_000)
    await check
    expect(signal?.aborted).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })

  it('a write that got its turn is not cut off by the wait deadline', async () => {
    let finish: (v: string) => void = () => undefined
    const p = serialized('id-c', () => new Promise<string>((r) => (finish = r)), 1_000)
    await vi.advanceTimersByTimeAsync(5_000)
    finish('done')
    await expect(p).resolves.toBe('done')
  })
})
