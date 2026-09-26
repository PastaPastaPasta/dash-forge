/**
 * Key top-up (`IdentityKeyLimitsUpdate`), the pure parts: amount parsing, the expiry rule, the
 * "something to change" check, and the Forge-browser-key guard.
 */

import { describe, expect, it } from 'vitest'

import { CREDITS_PER_DASH } from '../sdk/cost'
import { TOP_UP_MAX_DASH, assertTopUp, isForgeBrowserKey, parseDashAmount, topUpExpiry } from './limited-key'

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
  it('refuses a date in the past', () => {
    expect(() => topUpExpiry(now - 100, now - 1, now)).toThrow(/future/)
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
  const bound = (type: string) => ({ toJSON: () => ({ $type: type, id: 'G6T1mjQZJ4pqjaraEw71RRSbVasd7JSbgsWfmLUgNhL2' }) })
  it('accepts a HIGH, group-bound, budgeted key', () => {
    expect(isForgeBrowserKey({ securityLevelNumber: 2, contractBounds: bound('contractGroup'), totalBudget: 5n })).toBe(true)
  })
  it('refuses the master key, unbounded keys, other bounds and unbudgeted keys', () => {
    expect(isForgeBrowserKey({ securityLevelNumber: 0, contractBounds: bound('contractGroup'), totalBudget: 5n })).toBe(false)
    expect(isForgeBrowserKey({ securityLevelNumber: 1, contractBounds: bound('contractGroup'), totalBudget: 5n })).toBe(false)
    expect(isForgeBrowserKey({ securityLevelNumber: 2, totalBudget: 5n })).toBe(false)
    expect(isForgeBrowserKey({ securityLevelNumber: 2, contractBounds: bound('singleContract'), totalBudget: 5n })).toBe(false)
    expect(isForgeBrowserKey({ securityLevelNumber: 2, contractBounds: bound('contractGroup') })).toBe(false)
  })
})
