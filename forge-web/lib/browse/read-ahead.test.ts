/** readAheadSource (D-040): block reads, their edges, and the fallbacks to exact ranges. */

import { describe, expect, it } from 'vitest'

import { readAheadSource, type PackSource } from './reader'

function source(size: number, copies = 1): PackSource & { calls: [number, number, number | undefined][]; failBlocks: boolean } {
  const pack = Uint8Array.from({ length: size }, (_, i) => i % 251)
  const s = {
    calls: [] as [number, number, number | undefined][],
    failBlocks: false,
    fetchRange: async (_ref: number, start: number, end: number, copy?: number) => {
      s.calls.push([start, end, copy])
      if (s.failBlocks && end - start === 64) throw new Error('block failed')
      return pack.subarray(start, end)
    },
    copyCount: () => copies,
    sizeOf: () => size,
  }
  return s
}

const expected = (start: number, end: number): number[] => Array.from({ length: end - start }, (_, i) => (start + i) % 251)

describe('readAheadSource', () => {
  it('serves every range inside a block from one fetch', async () => {
    const inner = source(1000)
    const ra = readAheadSource(inner, 64)
    for (const [a, b] of [[0, 10], [10, 30], [30, 64]] as const) {
      expect([...(await ra.fetchRange(0, a, b))]).toEqual(expected(a, b))
    }
    expect(inner.calls).toEqual([[0, 64, undefined]])
  })

  it('reads a range crossing a block boundary exactly', async () => {
    const inner = source(1000)
    const ra = readAheadSource(inner, 64)
    expect([...(await ra.fetchRange(0, 60, 70))]).toEqual(expected(60, 70))
    expect(inner.calls).toEqual([[60, 70, undefined]])
  })

  it('clamps the last block to the pack size, and reads past the end exactly', async () => {
    const inner = source(100)
    const ra = readAheadSource(inner, 64)
    expect([...(await ra.fetchRange(0, 90, 100))]).toEqual(expected(90, 100))
    expect(inner.calls).toEqual([[64, 100, undefined]])
    await ra.fetchRange(0, 95, 120).catch(() => undefined)
    expect(inner.calls.at(-1)).toEqual([95, 120, undefined])
  })

  it('falls back to the exact range when a block fails', async () => {
    const inner = source(1000)
    inner.failBlocks = true
    const ra = readAheadSource(inner, 64)
    expect([...(await ra.fetchRange(0, 5, 9))]).toEqual(expected(5, 9))
    expect(inner.calls).toEqual([[0, 64, undefined], [5, 9, undefined]])
  })

  it('treats "no copy" and copy 0 as one block for a single-copy pack', async () => {
    const inner = source(1000)
    const ra = readAheadSource(inner, 64)
    await ra.fetchRange(0, 0, 10)
    await ra.fetchRange(0, 10, 20, 0)
    expect(inner.calls).toHaveLength(1)
  })

  it('keeps each copy of a multi-copy pack apart', async () => {
    const inner = source(1000, 2)
    const ra = readAheadSource(inner, 64)
    await ra.fetchRange(0, 0, 10, 0)
    await ra.fetchRange(0, 0, 10, 1)
    expect(inner.calls).toEqual([[0, 64, 0], [0, 64, 1]])
  })

  it('evicts the least recently used block past its limit', async () => {
    const inner = source(1000)
    const ra = readAheadSource(inner, 64, 2)
    await ra.fetchRange(0, 0, 1) // block 0
    await ra.fetchRange(0, 64, 65) // block 1
    await ra.fetchRange(0, 1, 2) // touch block 0
    await ra.fetchRange(0, 128, 129) // block 2 evicts block 1
    await ra.fetchRange(0, 2, 3) // block 0 still cached
    await ra.fetchRange(0, 65, 66) // block 1 fetched again
    expect(inner.calls.map(([s]) => s)).toEqual([0, 64, 128, 64])
  })

  it('reads the next blocks ahead once reads run through the pack in order (QW-027), and only then', async () => {
    const inner = source(1000)
    const ra = readAheadSource(inner, 64, 64, 2)
    await ra.fetchRange(0, 0, 1) // block 0: nothing ahead yet
    await ra.fetchRange(0, 200, 201) // block 3: a jump, not a run
    expect(inner.calls.map(([s]) => s)).toEqual([0, 192])
    await ra.fetchRange(0, 256, 257) // block 4 after block 3: blocks 5 and 6 are asked for too
    expect(inner.calls.map(([s]) => s)).toEqual([0, 192, 320, 384, 256])
    // The walk reaches them from memory, and keeps two blocks ahead of itself.
    await ra.fetchRange(0, 330, 331) // block 5
    expect(inner.calls.map(([s]) => s)).toEqual([0, 192, 320, 384, 256, 448])
    // Never past the end of the pack (blocks 0..15).
    await ra.fetchRange(0, 900, 901)
    await ra.fetchRange(0, 960, 961)
    expect(Math.max(...inner.calls.map(([s]) => s))).toBe(960)
  })
})
