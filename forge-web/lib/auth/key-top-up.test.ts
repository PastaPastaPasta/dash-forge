/**
 * Key top-up (`IdentityKeyLimitsUpdate`), the pure parts: amount parsing, the expiry rule, the
 * "something to change" check, and the Forge-browser-key guard.
 */

import { describe, expect, it } from 'vitest'

import { CREDITS_PER_DASH } from '../sdk/cost'
import { TOP_UP_MAX_DASH, TOP_UP_MAX_DAYS, assertTopUp, isForgeBrowserKey, parseDashAmount, topUpExpiry } from './limited-key'

const DASH = BigInt(CREDITS_PER_DASH)

describe('parseDashAmount', () => {
  it('converts DASH to credits exactly, without floats', () => {
    expect(parseDashAmount('0.05')).toBe(5_000_000_000n)
    expect(parseDashAmount('0.01')).toBe(1_000_000_000n)
    expect(parseDashAmount(' 1 ')).toBe(DASH)
    expect(parseDashAmount('.5')).toBe(DASH / 2n)
    expect(parseDashAmount('0.00000000001')).toBe(1n)
    // 0.1 + 0.2 is not 0.3 in floats; here it is exact.
    expect(parseDashAmount('0.3')).toBe(30_000_000_000n)
  })

  it('refuses what is not a plain positive amount', () => {
    for (const bad of ['', 'abc', '-1', '1e3', '0', '0.000', '1,5', '0.000000000001', '1.2.3', '$1']) {
      expect(() => parseDashAmount(bad), bad).toThrow()
    }
  })

  it('caps one top-up', () => {
    expect(parseDashAmount(String(TOP_UP_MAX_DASH))).toBe(BigInt(TOP_UP_MAX_DASH) * DASH)
    expect(() => parseDashAmount(String(TOP_UP_MAX_DASH + 1))).toThrow(/at most/)
  })
})

describe('topUpExpiry', () => {
  const now = 1_000_000
  it('asks for a later expiry only', () => {
    expect(topUpExpiry(now + 10, now + 20, now)).toBe(now + 20)
    expect(topUpExpiry(now + 20, now + 20, now)).toBeNull()
    expect(topUpExpiry(now + 30, now + 20, now)).toBeNull()
  })
  it('keeps the expiry when none is wanted, and sets one on a key without', () => {
    expect(topUpExpiry(now + 10, null, now)).toBeNull()
    expect(topUpExpiry(null, now + 5, now)).toBe(now + 5)
  })
  it('refuses a date in the past, and one more than a year out', () => {
    expect(() => topUpExpiry(now - 100, now - 1, now)).toThrow(/future/)
    const day = 24 * 60 * 60 * 1000
    expect(topUpExpiry(now, now + TOP_UP_MAX_DAYS * day, now)).toBe(now + TOP_UP_MAX_DAYS * day)
    expect(() => topUpExpiry(now, now + TOP_UP_MAX_DAYS * day + 1, now)).toThrow(/at most 365 days/)
  })
})

describe('assertTopUp', () => {
  it('needs budget or an expiry', () => {
    expect(() => assertTopUp({ addCredits: null, expiresAt: null })).toThrow(/nothing to change/)
    expect(() => assertTopUp({ addCredits: 0n, expiresAt: null })).toThrow(/nothing to change/)
    expect(() => assertTopUp({ addCredits: 1n, expiresAt: null })).not.toThrow()
    expect(() => assertTopUp({ addCredits: null, expiresAt: 5 })).not.toThrow()
  })
})

describe('isForgeBrowserKey', () => {
  const bound = (type: string) => ({ toJSON: () => ({ $type: type, id: 'FtHLFE1xLqn7s6FzS56GbY6Hh6KgLjCezNJ8HLUNJ3mc' }) })
  const key = { purposeNumber: 0, securityLevelNumber: 2, contractBounds: bound('contractGroup'), totalBudget: 5n }
  it('accepts an AUTHENTICATION / HIGH, group-bound, budgeted key', () => {
    expect(isForgeBrowserKey(key)).toBe(true)
  })
  it('refuses the master key, other purposes, unbounded keys, other bounds and unbudgeted keys', () => {
    expect(isForgeBrowserKey({ ...key, securityLevelNumber: 0 })).toBe(false)
    expect(isForgeBrowserKey({ ...key, securityLevelNumber: 1 })).toBe(false)
    expect(isForgeBrowserKey({ ...key, purposeNumber: 1 })).toBe(false)
    expect(isForgeBrowserKey({ ...key, contractBounds: undefined })).toBe(false)
    expect(isForgeBrowserKey({ ...key, contractBounds: bound('singleContract') })).toBe(false)
    expect(isForgeBrowserKey({ ...key, totalBudget: undefined })).toBe(false)
  })
})
