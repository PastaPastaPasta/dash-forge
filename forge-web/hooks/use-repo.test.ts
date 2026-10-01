import { describe, expect, it } from 'vitest'

import { homeCacheKey, homeCacheKeys, keepLastGood } from './use-repo'

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

describe('the home cache keys (refs: default)', () => {
  const addr = { owner: 'dash', name: 'dash', repoId: '' }

  it("a list page's home of the default branch alone is cached apart from the full home", () => {
    expect(homeCacheKey('devnet', addr, 'default')).not.toBe(homeCacheKey('devnet', addr))
  })

  it('a list page takes a cached full home first; a page that lists refs takes only a full one', () => {
    const full = homeCacheKey('devnet', addr)
    expect(homeCacheKeys(homeCacheKey('devnet', addr, 'default'))).toEqual([full, homeCacheKey('devnet', addr, 'default')])
    expect(homeCacheKeys(full)).toEqual([full])
  })
})
