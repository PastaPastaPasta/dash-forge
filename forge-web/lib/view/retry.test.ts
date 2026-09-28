import { describe, expect, it } from 'vitest'

import { readUntil } from './retry'

describe('readUntil: re-read after a write until it shows', () => {
  it('re-reads until every expectation holds', async () => {
    let n = 0
    const out = await readUntil(async () => ++n, [(v) => v >= 2, (v) => v >= 3], { attempts: 8, delayMs: 0 })
    expect(out).toBe(3)
  })

  it('stops polling once aborted (a newer refresh took over), returning what it has', async () => {
    let n = 0
    const signal = { aborted: false }
    const out = await readUntil(
      async () => {
        n += 1
        if (n === 2) signal.aborted = true
        return n
      },
      [() => false],
      { attempts: 8, delayMs: 0, signal },
    )
    expect(out).toBe(2)
    expect(n).toBe(2)
  })

  it('gives up after the attempts, and a null read is returned at once', async () => {
    let n = 0
    expect(await readUntil(async () => ++n, [() => false], { attempts: 3, delayMs: 0 })).toBe(4)
    expect(await readUntil(async () => null, [() => false], { attempts: 3, delayMs: 0 })).toBeNull()
  })
})
