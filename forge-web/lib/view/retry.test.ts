import { describe, expect, it } from 'vitest'

import { readUntil, retryWhileMissing } from './retry'

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

  it('backs off between re-reads, up to a cap', async () => {
    const waits: number[] = []
    const real = globalThis.setTimeout
    globalThis.setTimeout = ((f: () => void, ms: number) => {
      waits.push(ms)
      return real(f, 0)
    }) as typeof setTimeout
    try {
      await readUntil(async () => 1, [() => false], { attempts: 5, delayMs: 1000, backoff: 2, maxDelayMs: 5000 })
    } finally {
      globalThis.setTimeout = real
    }
    expect(waits).toEqual([1000, 2000, 4000, 5000, 5000])
  })

  it('gives up after the attempts, and a null read is returned at once', async () => {
    let n = 0
    expect(await readUntil(async () => ++n, [() => false], { attempts: 3, delayMs: 0 })).toBe(4)
    expect(await readUntil(async () => null, [() => false], { attempts: 3, delayMs: 0 })).toBeNull()
  })
})

describe('retryWhileMissing', () => {
  it('stops retrying a not-found once a newer read took over', async () => {
    let n = 0
    const signal = { aborted: false }
    const out = retryWhileMissing(async () => (++n, null), 8, 0, signal)
    signal.aborted = true
    expect(await out).toBeNull()
    expect(n).toBe(1)
  })
})

describe('readUntil with the first read (L-77)', () => {
  it('checks a first read it is handed before reading again: a cold page load reads once', async () => {
    let n = 0
    expect(await readUntil(async () => ++n, [], { delayMs: 0, first: 7 })).toBe(7)
    expect(n).toBe(0)
    expect(await readUntil(async () => ++n, [(v) => v >= 1], { delayMs: 0, first: 1 })).toBe(1)
    expect(n).toBe(0)
  })

  it('re-reads only while an expectation fails of the first read', async () => {
    let n = 0
    expect(await readUntil(async () => ++n, [(v) => v >= 2], { delayMs: 0, first: 0 })).toBe(2)
    expect(n).toBe(2)
  })
})
