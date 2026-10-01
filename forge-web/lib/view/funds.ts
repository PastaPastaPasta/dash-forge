/**
 * Funds states (`ux-dx-spec.md` §4): the identity's balance and, for a limited key, what is
 * left of its budget and how long until it expires. The two budgets are judged separately and
 * the worse one wins; the UI says which one blocks.
 */

import { CREDITS_PER_DASH, type CostPreview } from '../sdk/cost'

/** Below this balance the pill turns amber (0.01 DASH). */
export const LOW_BALANCE_CREDITS = CREDITS_PER_DASH / 100
/** A key with less than this fraction of its budget left is "low". */
const LOW_KEY_FRACTION = 0.2
/** A key expiring within this many ms is "low". */
const LOW_KEY_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

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

/**
 * This browser's key budget in words, the same everywhere it shows (QW3-033: the account menu
 * said the balance caps it, while Settings and the funds pill said "0.05 of 0.05 DASH" to an
 * identity holding 0.005121): what is left of the budget, and, when the identity's balance is
 * below that, that the balance caps it. Null for a key without a budget.
 */
export function keyBudgetWords(
  key: KeyLimits | null,
  balance: bigint | string | null,
  dash: (credits: number) => string,
  now = Date.now(),
): { readonly left: string; readonly cap: string | null } | null {
  if (key === null || key.remaining === null || key.total === null) return null
  const left = dash(Number(key.remaining))
  const have = balance === null ? null : BigInt(balance) < 0n ? 0n : BigInt(balance)
  // No cap for an expired key (it spends nothing; its expiry says so), nor one the rounding
  // would print as "0.05 of 0.05 DASH, capped by your 0.05 DASH balance".
  const expired = key.expiresAt !== null && key.expiresAt <= now
  const capped = have !== null && have < key.remaining && !expired && dash(Number(have)) !== left
  return { left: `${left} of ${dash(Number(key.total))} DASH`, cap: capped ? `capped by your ${dash(Number(have))} DASH balance` : null }
}

/**
 * The top-up sheet's coverage line: what an issue costs, and how many the funds a write can use
 * cover now (`spendable`: the balance, capped by this browser's key budget). QW2-035: it said
 * "0.05 DASH covers about 40", the key's budget, to an identity with 0.0054 DASH.
 */
export function issueCoverage(spendable: bigint | null, issueCredits: number, dash: (credits: number) => string): string {
  const each = `About ${dash(issueCredits)} DASH covers an issue`
  if (spendable === null) return `${each}.`
  const n = Math.floor(Number(spendable) / issueCredits)
  if (n === 0) return `${each}; what you can spend now does not cover one.`
  return `${each}; what you can spend now covers about ${n === 1 ? 'one' : n}.`
}

/** The one fix a low or empty state needs (`ux-dx-spec.md` §4: top up / renew key). */
export type FundsFix = 'top-up' | 'renew-key'

/**
 * What the low-balance banner says for a funds state, or null when there is nothing to say
 * (comfortable). `key` names the state, so dismissing "low balance" does not also hide a later
 * "key expired" (one dismissal per state per session).
 */
export function fundsNotice(state: FundsState): { readonly key: string; readonly message: string; readonly fix: FundsFix } | null {
  if (state.level === 'comfortable') return null
  const reason = state.reason ?? 'balance'
  const empty = state.level === 'empty'
  const key = `${state.level}:${reason}`
  if (reason === 'balance') {
    return {
      key,
      fix: 'top-up',
      message: empty
        ? 'Your balance is 0: writes are off until you top up. Reading still works.'
        : 'Your balance is under 0.01 DASH, enough for only a few more writes. Top up to keep writing.',
    }
  }
  if (reason === 'key-budget') {
    return {
      key,
      fix: 'renew-key',
      message: empty
        ? "This browser's key has spent its budget: writes are off until you renew it. Reading still works."
        : "This browser's key has less than 20 % of its budget left. Renew it (or top up its budget in Settings).",
    }
  }
  return {
    key,
    fix: 'renew-key',
    message: empty
      ? "This browser's key has expired: writes are off until you renew it. Reading still works."
      : "This browser's key expires within 7 days. Renew it to keep writing.",
  }
}


/**
 * When {@link fundsState} next changes by the clock alone: the key's expiry, or the moment it
 * comes within {@link LOW_KEY_EXPIRY_MS} of it. Null when nothing is ahead.
 */
export function nextFundsChange(key: KeyLimits | null, now = Date.now()): number | null {
  const at = key?.expiresAt ?? null
  if (at === null || at <= now) return null
  const low = at - LOW_KEY_EXPIRY_MS
  return low > now ? low : at
}

/** What a write needs available: its preview, or a bare estimate (then it needs that much). */
export type WriteNeed = number | Pick<CostPreview, 'credits' | 'admit'>

/**
 * Whether a write fits, and if not, which budget blocks it (D-012). Platform accepts a write
 * only when the key budget and the balance cover what Drive estimates it may take
 * (`CostPreview.admit`), which is more than it charges; a write short of that is refused and
 * would have shown as "sent". So the check compares against `admit`, never the raw estimate.
 * A bare number (a caller with no preview) is taken as both.
 */
export function affordability(
  need: WriteNeed,
  balance: bigint,
  key: KeyLimits | null = null,
): { ok: true } | { ok: false; blocker: 'balance' | 'key-budget'; shortfall: bigint } {
  const credits = typeof need === 'number' ? need : need.credits
  if (credits <= 0) return { ok: true }
  const admit = typeof need === 'number' ? { budget: credits, balance: credits } : need.admit
  const budgetNeed = BigInt(Math.ceil(admit.budget))
  const balanceNeed = BigInt(Math.ceil(admit.balance))
  const keyLeft = key?.remaining ?? null
  const keyShort = keyLeft !== null && keyLeft < budgetNeed
  const balanceShort = balance < balanceNeed
  // Both short: name the one that leaves less (topping up the other alone would not help).
  if (keyShort && (!balanceShort || keyLeft <= balance)) return { ok: false, blocker: 'key-budget', shortfall: budgetNeed - keyLeft }
  if (balanceShort) return { ok: false, blocker: 'balance', shortfall: balanceNeed - balance }
  return { ok: true }
}
