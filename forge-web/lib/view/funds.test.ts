import { describe, expect, it } from 'vitest'

import { affordability, fundsNotice, fundsState, LOW_BALANCE_CREDITS, nextFundsChange } from './funds'
import { previewCreate } from '../sdk/cost'
import { estimateMissed, reconcile, summarize, type SpendRow } from '../spend'

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

describe('fundsNotice (the low-balance banner, ux-dx-spec §4)', () => {
  const key = (remaining: bigint, expiresIn: number) => ({ remaining, total: 5_000_000_000n, expiresAt: NOW + expiresIn })
  it('says nothing when comfortable', () => {
    expect(fundsNotice(fundsState(10n ** 11n, key(4_000_000_000n, 90 * DAY), NOW))).toBeNull()
  })
  it('names the specific fix: top up a low balance, renew a low or expiring key', () => {
    expect(fundsNotice(fundsState(BigInt(LOW_BALANCE_CREDITS - 1), null, NOW))).toMatchObject({ key: 'low:balance', fix: 'top-up' })
    expect(fundsNotice(fundsState(10n ** 11n, key(900_000_000n, 90 * DAY), NOW))).toMatchObject({ key: 'low:key-budget', fix: 'renew-key' })
    expect(fundsNotice(fundsState(10n ** 11n, key(4_000_000_000n, 3 * DAY), NOW))).toMatchObject({ key: 'low:key-expiry', fix: 'renew-key' })
  })
  it('says writes are off when empty, with a distinct key per state (a new state shows again)', () => {
    const empty = fundsNotice(fundsState(0n, null, NOW))
    expect(empty).toMatchObject({ key: 'empty:balance', fix: 'top-up' })
    expect(empty?.message).toMatch(/writes are off/)
    expect(fundsNotice(fundsState(10n ** 11n, key(4_000_000_000n, -1), NOW))).toMatchObject({ key: 'empty:key-expiry', fix: 'renew-key' })
    expect(fundsNotice(fundsState(10n ** 11n, key(0n, 90 * DAY), NOW))?.key).toBe('empty:key-budget')
  })
})

describe('affordability compares what Platform needs available, not the estimate (D-012)', () => {
  // QA B-BUDGET3: an issue estimated at 0.000585 DASH, a key with 0.0009 left, refused on chain
  // because Drive required 100,224,000 credits from the key's budget.
  const issue = previewCreate('issue', { title: 'bob budget issue' })
  const key = { remaining: 90_000_000n, total: 90_000_000n, expiresAt: null }
  it('blocks the write QA saw refused, before signing', () => {
    expect(issue.credits).toBeLessThan(200_000_000)
    expect(affordability(issue, 10n ** 11n, key)).toMatchObject({ ok: false, blocker: 'key-budget' })
  })
  it('names the shortfall against the requirement', () => {
    const r = affordability(issue, 10n ** 11n, key)
    expect(r.ok ? 0n : r.shortfall).toBe(BigInt(issue.admit.budget) - 90_000_000n)
  })
  it('blocks a balance that covers the charge but not the requirement (QA B-LOWBAL)', () => {
    // 111,153,640 credits left; Drive required 137,618,340 for the next issue.
    expect(affordability(issue, 111_153_640n)).toMatchObject({ ok: false, blocker: 'balance' })
  })
  it('passes when both cover the requirement', () => {
    expect(affordability(issue, 10n ** 11n, { remaining: 5_000_000_000n, total: 5_000_000_000n, expiresAt: null })).toEqual({ ok: true })
  })
})

describe('nextFundsChange wakes the pill when the key expires (D-042)', () => {
  it('is the 7-day mark first, then the expiry, then nothing', () => {
    const at = NOW + 30 * DAY
    const k = { remaining: 1n, total: 1n, expiresAt: at }
    expect(nextFundsChange(k, NOW)).toBe(at - 7 * DAY)
    expect(nextFundsChange(k, at - DAY)).toBe(at)
    expect(nextFundsChange(k, at + 1)).toBeNull()
    expect(nextFundsChange(null, NOW)).toBeNull()
  })
  it('the state it wakes to is empty / key-expiry', () => {
    const k = { remaining: 5n, total: 5n, expiresAt: NOW + 1000 }
    expect(fundsState(10n ** 11n, k, NOW).level).toBe('low')
    expect(fundsState(10n ** 11n, k, NOW + 1000)).toMatchObject({ level: 'empty', reason: 'key-expiry' })
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
