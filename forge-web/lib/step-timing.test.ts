import { afterEach, describe, expect, it } from 'vitest'

import { stepClock, timed } from './step-timing'

function measures(prefix: string): string[] {
  return performance
    .getEntriesByType('measure')
    .map((m) => m.name)
    .filter((n) => n.startsWith(prefix))
}

afterEach(() => performance.clearMeasures())

describe('step timing (L-20)', () => {
  it('each step ends when the next starts; null ends the last', () => {
    const step = stepClock('t1')
    step('Connecting')
    step('Enabling private repos')
    expect(measures('forge:t1:')).toEqual(['forge:t1:Connecting'])
    step(null)
    step(null)
    expect(measures('forge:t1:')).toEqual(['forge:t1:Connecting', 'forge:t1:Enabling private repos'])
  })

  it('times work whether it succeeds or fails, and passes its result through', async () => {
    expect(await timed('t2', 'ok', async () => 7)).toBe(7)
    await expect(timed('t2', 'fails', async () => Promise.reject(new Error('no')))).rejects.toThrow('no')
    expect(measures('forge:t2:')).toEqual(['forge:t2:ok', 'forge:t2:fails'])
  })
})
