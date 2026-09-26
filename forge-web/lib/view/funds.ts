/**
 * Funds states (`ux-dx-spec.md` §4): the identity's balance and, for a limited key, what is
 * left of its budget and how long until it expires. The two budgets are judged separately and
 * the worse one wins; the UI says which one blocks.
 */

import { CREDITS_PER_DASH } from '../sdk/cost'

/** Below this balance the pill turns amber (0.01 DASH). */
export const LOW_BALANCE_CREDITS = CREDITS_PER_DASH / 100
/** A key with less than this fraction of its budget left is "low". */
export const LOW_KEY_FRACTION = 0.2
/** A key expiring within this many ms is "low". */
export const LOW_KEY_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

export type FundsLevel = 'comfortable' | 'low' | 'empty'

/** The signing key's limits, when it has any (a PV14 limited key). */
export interface KeyLimits {
  /** Credits left of the key's budget; null when the key has no budget. */
  readonly remaining: bigint | null
  /** The key's total budget; null when it has none. */
  readonly total: bigint | null
  /** Expiry (ms since epoch); null when the key does not expire. */
  readonly expiresAt: number | null
}

export interface FundsState {
  readonly level: FundsLevel
  /** Which budget sets `level`: the identity balance or this key. */
  readonly reason: 'balance' | 'key-budget' | 'key-expiry' | null
  /** What a write may spend at most: min(balance, key budget left). */
  readonly spendable: bigint
}

/** Judge a balance (credits) and an optional key's limits. */
export function fundsState(balance: bigint, key: KeyLimits | null = null, now = Date.now()): FundsState {
  const keyLeft = key?.remaining ?? null
  const spendable = keyLeft !== null && keyLeft < balance ? keyLeft : balance
  if (key?.expiresAt != null && key.expiresAt <= now) return { level: 'empty', reason: 'key-expiry', spendable: 0n }
  if (balance <= 0n) return { level: 'empty', reason: 'balance', spendable: 0n }
  if (keyLeft !== null && keyLeft <= 0n) return { level: 'empty', reason: 'key-budget', spendable: 0n }
  if (balance < BigInt(LOW_BALANCE_CREDITS)) return { level: 'low', reason: 'balance', spendable }
  if (keyLeft !== null && key?.total != null && key.total > 0n && Number(keyLeft) < Number(key.total) * LOW_KEY_FRACTION) {
    return { level: 'low', reason: 'key-budget', spendable }
  }
  if (key?.expiresAt != null && key.expiresAt - now < LOW_KEY_EXPIRY_MS) return { level: 'low', reason: 'key-expiry', spendable }
  return { level: 'comfortable', reason: null, spendable }
}

/** Whether a write estimated at `credits` fits, and if not, which budget blocks it. */
export function affordability(
  estimateCredits: number,
  balance: bigint,
  key: KeyLimits | null = null,
): { ok: true } | { ok: false; blocker: 'balance' | 'key-budget'; shortfall: bigint } {
  if (estimateCredits <= 0) return { ok: true }
  const need = BigInt(Math.ceil(estimateCredits))
  const keyLeft = key?.remaining ?? null
  if (keyLeft !== null && keyLeft < need && keyLeft <= balance) return { ok: false, blocker: 'key-budget', shortfall: need - keyLeft }
  if (balance < need) return { ok: false, blocker: 'balance', shortfall: need - balance }
  return { ok: true }
}
