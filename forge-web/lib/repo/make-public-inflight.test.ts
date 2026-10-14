/** The runs in flight in this tab (M4): one per network and repo, told to listeners as they start and settle. */

import { describe, expect, it, vi } from 'vitest'

import { beginMakePublicRun, makePublicInFlight, subscribeMakePublicRuns } from './make-public-inflight'

describe('runs in flight', () => {
  it('admits one run per repo until it settles, and tells listeners', () => {
    const told = vi.fn()
    const unsubscribe = subscribeMakePublicRuns(told)
    const end = beginMakePublicRun('devnet', 'R')
    expect(end).not.toBeNull()
    expect(makePublicInFlight('devnet', 'R')).toBe(true)
    // a second run on the same repo waits; another repo or network is unaffected
    expect(beginMakePublicRun('devnet', 'R')).toBeNull()
    expect(makePublicInFlight('testnet', 'R')).toBe(false)
    const other = beginMakePublicRun('devnet', 'S')
    expect(told).toHaveBeenCalledTimes(2)
    end!()
    end!()
    expect(told).toHaveBeenCalledTimes(3)
    expect(makePublicInFlight('devnet', 'R')).toBe(false)
    const next = beginMakePublicRun('devnet', 'R')
    expect(next).not.toBeNull()
    next!()
    other!()
    unsubscribe()
  })
})
