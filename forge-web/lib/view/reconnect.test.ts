import { describe, expect, it } from 'vitest'

import { nextBackoff, noteReadOutage, readOutages, subscribeReadOutages } from './reconnect'

describe('reconnect backoff (L-56)', () => {
  it('grows while retries keep failing, caps, and starts over after a quiet spell', () => {
    const t0 = 1_000_000_000
    // Far from any earlier retry: a new streak.
    expect(nextBackoff(t0)).toBe(2_000)
    expect(nextBackoff(t0 + 2_000)).toBe(5_000)
    expect(nextBackoff(t0 + 7_000)).toBe(15_000)
    expect(nextBackoff(t0 + 22_000)).toBe(30_000)
    expect(nextBackoff(t0 + 52_000)).toBe(60_000)
    expect(nextBackoff(t0 + 112_000)).toBe(60_000) // capped
    // Ten minutes of calm: the next outage starts at the short wait again.
    expect(nextBackoff(t0 + 712_000)).toBe(2_000)
  })
})

describe('read outages (L-10)', () => {
  it('counts per repo and tells subscribers', () => {
    let calls = 0
    const stop = subscribeReadOutages(() => calls++)
    const before = readOutages('repo-a')
    noteReadOutage('repo-a')
    noteReadOutage('repo-a')
    expect(readOutages('repo-a')).toBe(before + 2)
    expect(readOutages('repo-b')).toBe(0)
    expect(calls).toBe(2)
    stop()
    noteReadOutage('repo-a')
    expect(calls).toBe(2)
  })
})
