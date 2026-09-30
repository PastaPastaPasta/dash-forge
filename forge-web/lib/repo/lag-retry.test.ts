/**
 * `retryAfterLag`: a 10422 refusal by a total-reading rule is retried after about a block, with
 * a bounded backoff; anything else is thrown at once.
 */

import { describe, expect, it, vi } from 'vitest'

const slept: number[] = []
vi.mock('../sdk/facade', async (orig) => ({
  ...(await orig<typeof import('../sdk/facade')>()),
  sleep: (ms: number) => {
    slept.push(ms)
    return Promise.resolve()
  },
}))

const { ConsensusRefusal } = await import('../sdk')
const { LAG_RETRY_MS, isRuleRefusal, retryAfterLag } = await import('./lag-retry')

const refusal = (rule: string) => new ConsensusRefusal(10422, `breaks its propertyConstraints rule "${rule}": NotMet`)
const RULES = new Set(['platformChunks', 'dense'])

describe('retryAfterLag', () => {
  it('retries a named rule after each wait, calling the write afresh', async () => {
    slept.length = 0
    let calls = 0
    const r = await retryAfterLag(async () => {
      calls++
      if (calls < 3) throw refusal('dense')
      return 'ok'
    }, RULES)
    expect(r).toBe('ok')
    expect(calls).toBe(3)
    expect(slept).toEqual(LAG_RETRY_MS.slice(0, 2))
  })

  it('stops after the last wait, and throws any other error at once', async () => {
    slept.length = 0
    const always = vi.fn(async () => {
      throw refusal('platformChunks')
    })
    await expect(retryAfterLag(always, RULES)).rejects.toThrow(/platformChunks/)
    expect(always).toHaveBeenCalledTimes(LAG_RETRY_MS.length + 1)
    const other = vi.fn(async () => {
      throw refusal('noPlain')
    })
    await expect(retryAfterLag(other, RULES)).rejects.toThrow(/noPlain/)
    expect(other).toHaveBeenCalledTimes(1)
    expect(isRuleRefusal(new Error('rule "dense"'), RULES)).toBe(false)
  })
})
