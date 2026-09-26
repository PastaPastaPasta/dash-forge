import { describe, expect, it } from 'vitest'

import { affordability, fundsState, LOW_BALANCE_CREDITS } from './funds'
import { estimateMissed, reconcile, summarize, type SpendRow } from '../spend'
import { stateEventRoute } from '../repo/writes'

const NOW = 1_800_000_000_000
const DAY = 86_400_000

describe('fundsState (ux-dx-spec §4)', () => {
  it('is comfortable with a healthy balance and no key limits', () => {
    expect(fundsState(10n ** 11n, null, NOW)).toMatchObject({ level: 'comfortable', reason: null })
  })
  it('is low under 0.01 DASH', () => {
    expect(fundsState(BigInt(LOW_BALANCE_CREDITS - 1), null, NOW)).toMatchObject({ level: 'low', reason: 'balance' })
  })
  it('is empty at zero balance', () => {
    expect(fundsState(0n, null, NOW)).toMatchObject({ level: 'empty', reason: 'balance' })
  })
  it('judges a limited key: < 20 % budget or < 7 days is low; spent or expired is empty', () => {
    const key = (remaining: bigint, expiresIn: number) => ({ remaining, total: 5_000_000_000n, expiresAt: NOW + expiresIn })
    expect(fundsState(10n ** 11n, key(4_000_000_000n, 90 * DAY), NOW).level).toBe('comfortable')
    expect(fundsState(10n ** 11n, key(900_000_000n, 90 * DAY), NOW)).toMatchObject({ level: 'low', reason: 'key-budget' })
    expect(fundsState(10n ** 11n, key(4_000_000_000n, 3 * DAY), NOW)).toMatchObject({ level: 'low', reason: 'key-expiry' })
    expect(fundsState(10n ** 11n, key(0n, 90 * DAY), NOW)).toMatchObject({ level: 'empty', reason: 'key-budget' })
    expect(fundsState(10n ** 11n, key(4_000_000_000n, -1), NOW)).toMatchObject({ level: 'empty', reason: 'key-expiry' })
  })
  it('spendable is the smaller of balance and key budget', () => {
    expect(fundsState(10n ** 11n, { remaining: 5n, total: 10n, expiresAt: null }, NOW).spendable).toBe(5n)
  })
})

describe('affordability names the blocking budget', () => {
  it('passes a write that fits both', () => {
    expect(affordability(1000, 10_000n, { remaining: 5000n, total: 10_000n, expiresAt: null })).toEqual({ ok: true })
  })
  it('blames the key budget when it is the smaller one', () => {
    expect(affordability(1000, 10_000n, { remaining: 500n, total: 10_000n, expiresAt: null })).toEqual({
      ok: false,
      blocker: 'key-budget',
      shortfall: 500n,
    })
  })
  it('blames the balance otherwise', () => {
    expect(affordability(1000, 400n)).toEqual({ ok: false, blocker: 'balance', shortfall: 600n })
  })
  it('never blocks a refund', () => {
    expect(affordability(-2000, 0n)).toEqual({ ok: true })
  })
})

describe('spend ledger', () => {
  const row = (at: number, estimate: number, actual: number | null, repo = 'R'): SpendRow => ({
    at,
    identityId: 'I',
    network: 'devnet',
    kind: 'create:issue',
    repo,
    documentId: String(at),
    estimateCredits: estimate,
    actualCredits: actual,
  })
  it('flags a >25 % miss only', () => {
    expect(estimateMissed(row(1, 100, 124))).toBe(false)
    expect(estimateMissed(row(1, 100, 126))).toBe(true)
    expect(estimateMissed(row(1, 100, null))).toBe(false)
  })
  it('summarizes month, all-time and per repo, counting refunds negative', () => {
    const now = new Date(2026, 8, 20).getTime()
    const rows = [row(new Date(2026, 7, 1).getTime(), 50, 60, 'A'), row(now - 1000, 50, 40, 'B'), row(now, -20, -23, 'B')]
    const s = summarize(rows, now)
    expect(s.allTime).toBe(77)
    expect(s.thisMonth).toBe(17)
    expect(s.byRepo).toEqual([
      { repo: 'A', credits: 60, writes: 1 },
      { repo: 'B', credits: 17, writes: 2 },
    ])
  })
  it('reconciles against the balance change since the baseline', () => {
    expect(reconcile(100, 1000n, 880n)).toEqual({ balanceChange: 120, unexplained: 20 })
    expect(reconcile(100, null, 880n)).toBeNull()
  })
})

describe('state-event routing (forge-v2 §3)', () => {
  it('uses event for members, authorEvent for a non-member author, nothing for strangers', () => {
    expect(stateEventRoute({ viewer: 'a', author: 'a', isMember: true })).toBe('event')
    expect(stateEventRoute({ viewer: 'a', author: 'a', isMember: false })).toBe('authorEvent')
    expect(stateEventRoute({ viewer: 'b', author: 'a', isMember: false })).toBeNull()
  })
})
