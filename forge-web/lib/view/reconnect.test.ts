import { describe, expect, it } from 'vitest'

import { nextBackoff, noteReadOutage, readOutages, subscribeReadOutages } from './reconnect'

describe('reconnect backoff (L-56)', () => {
  const mid = (): number => 0.5 // no jitter
  it('grows while retries keep failing, caps, and starts over after a quiet spell', () => {
    const t0 = 1_000_000_000
    // Far from any earlier retry: a new streak.
    expect(nextBackoff(t0, mid)).toBe(2_000)
    expect(nextBackoff(t0 + 2_000, mid)).toBe(5_000)
    expect(nextBackoff(t0 + 7_000, mid)).toBe(15_000)
    expect(nextBackoff(t0 + 22_000, mid)).toBe(30_000)
    expect(nextBackoff(t0 + 52_000, mid)).toBe(60_000)
    expect(nextBackoff(t0 + 112_000, mid)).toBe(60_000) // capped
    // Ten minutes of calm: the next outage starts at the short wait again.
    expect(nextBackoff(t0 + 712_000, mid)).toBe(2_000)
  })

  it('spreads each wait by ±30% (M3)', () => {
    const t = 2_000_000_000
    expect(nextBackoff(t, () => 0)).toBe(1_400)
    expect(nextBackoff(t + 10_000_000, () => 1)).toBe(2_600)
  })
})

describe('read outages (L-10)', () => {
  it('counts per repo and tells subscribers', async () => {
    let calls = 0
    const stop = subscribeReadOutages(() => calls++)
    const before = readOutages('repo-a')
    // One burst (a page's reads failing together) is one outage, announced once (M3).
    noteReadOutage('repo-a')
    noteReadOutage('repo-a')
    noteReadOutage('repo-a')
    await Promise.resolve()
    expect(readOutages('repo-a')).toBe(before + 1)
    expect(calls).toBe(1)
    noteReadOutage('repo-a')
    await Promise.resolve()
    expect(readOutages('repo-a')).toBe(before + 2)
    expect(readOutages('repo-b')).toBe(0)
    expect(calls).toBe(2)
    stop()
    noteReadOutage('repo-a')
    await Promise.resolve()
    expect(calls).toBe(2)
  })
})
