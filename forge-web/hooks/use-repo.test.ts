import { describe, expect, it } from 'vitest'

import { keepLastGood } from './use-repo'

const TIMEOUT = new Error('Platform read timed out after 30 s')

describe('keepLastGood (stale-if-error)', () => {
  it('falls back only while Platform is reported unreachable', () => {
    expect(keepLastGood(TIMEOUT, { phase: 'error', message: 'down', retryAt: null })).toBe(true)
  })

  it('surfaces a one-off timeout while connected, so stale content never sits under "Verified"', () => {
    expect(keepLastGood(TIMEOUT, { phase: 'ready' })).toBe(false)
  })

  it('surfaces a proof failure even during an outage', () => {
    expect(keepLastGood(new Error('proof verification error'), { phase: 'error', message: 'down', retryAt: null })).toBe(false)
  })
})
