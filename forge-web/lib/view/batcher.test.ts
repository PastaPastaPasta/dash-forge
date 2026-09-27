import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBatcher } from './batcher'
import { mapPooled } from './pool'

describe('createBatcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces values that land within the window into one commit', () => {
    const commits: string[][] = []
    const b = createBatcher<string, number>(100, (batch) => commits.push([...batch.keys()]))
    b.add('a', 1)
    b.add('b', 2)
    expect(commits).toEqual([])
    vi.advanceTimersByTime(100)
    expect(commits).toEqual([['a', 'b']])
  })

  it('commits a value that lands after a flush (D-005)', () => {
    const committed = new Map<string, number>()
    const b = createBatcher<string, number>(100, (batch) => batch.forEach((v, k) => committed.set(k, v)))
    b.add('first', 1)
    vi.advanceTimersByTime(100)
    b.add('late', 2)
    vi.advanceTimersByTime(100)
    expect([...committed.keys()]).toEqual(['first', 'late'])
  })

  it('commits what is queued at once on flush, and nothing twice', () => {
    const commits: string[][] = []
    const b = createBatcher<string, number>(50, (batch) => commits.push([...batch.keys()]))
    b.add('a', 1)
    b.flush()
    expect(commits).toEqual([['a']])
    vi.advanceTimersByTime(100)
    b.flush()
    expect(commits).toEqual([['a']])
  })

  it('loses no load when pooled loads finish across several flush windows', async () => {
    // The diff view's shape: four loads in flight, finishing at staggered times either side
    // of flushes. Every one must reach a commit.
    const committed = new Set<number>()
    const b = createBatcher<number, number>(100, (batch) => batch.forEach((_, k) => committed.add(k)))
    const items = Array.from({ length: 30 }, (_, i) => i)
    const done = mapPooled(items, 4, async (i) => {
      await new Promise((r) => setTimeout(r, 37 * ((i * 7) % 5) + 10))
      b.add(i, await Promise.resolve(i))
    })
    await vi.runAllTimersAsync()
    await done
    await vi.runAllTimersAsync()
    expect([...committed].sort((x, y) => x - y)).toEqual(items)
  })
})
