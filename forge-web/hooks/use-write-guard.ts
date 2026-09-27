'use client'

/**
 * useWriteGuard — the checks every signing button runs before it signs, and what it does when
 * a write fails (`ux-dx-spec.md` §4):
 *
 * - before: signed out opens the sign-in sheet; an empty balance, a spent or expired key, or
 *   a write whose preview does not fit either budget (D-012: what Platform needs available,
 *   `CostPreview.admit`, not the raw estimate) opens the top-up sheet with the shortfall. A
 *   write to a Forge contract the session holds no key for (a wallet granted forge-core only)
 *   opens the one-tap wallet grant first.
 * - after a failure ({@link WriteGuard.failed}): the fix Platform's answer calls for opens —
 *   renew or top up the key, top up the balance — and the balance and key limits are read
 *   again so the pill shows what the chain says (D-007, D-042). It returns the sentence to show.
 */

import { useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { affordability, type WriteNeed } from '@/lib/view/funds'
import { writeFailure } from '@/lib/view/write-errors'

export interface WriteGuard {
  /**
   * Run before signing: true when the write may go ahead (else a sheet opened). `need`: the
   * write's cost preview (or a bare estimate). `contract`: which Forge contract the write goes
   * to, `'collab'` for issues, comments, reviews, stars and follows (default `'core'`).
   */
  readonly check: (need: WriteNeed, contract?: 'core' | 'collab') => boolean
  /** Run when a write throws: opens the fix it calls for and returns the message to show. */
  readonly failed: (e: unknown) => string
  /** Why every write button is disabled (empty state), or null. */
  readonly disabledReason: string | null
}

const EMPTY_REASON: Readonly<Record<'balance' | 'key-budget' | 'key-expiry', string>> = {
  balance: 'Balance is 0 — reading still works.',
  'key-budget': "This browser's key budget is spent — reading still works.",
  'key-expiry': "This browser's key has expired — reading still works.",
}

export function useWriteGuard(): WriteGuard {
  const { identity, signer, balance, funds, keyLimits, grants, refreshBalance } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const openTopUp = useUiStore((s) => s.openTopUp)

  const check = useCallback(
    (need: WriteNeed, contract: 'core' | 'collab' = 'core'): boolean => {
      if (!identity || !signer) {
        openLogin()
        return false
      }
      if (grants && !grants[contract]) {
        openLogin('grant')
        return false
      }
      if (funds?.level === 'empty') {
        openTopUp({ blocker: funds.reason ?? 'balance' })
        return false
      }
      const a = affordability(need, BigInt(balance ?? '0'), keyLimits)
      if (!a.ok) {
        openTopUp({ blocker: a.blocker, shortfall: a.shortfall })
        return false
      }
      return true
    },
    [balance, funds, grants, identity, keyLimits, openLogin, openTopUp, signer],
  )

  const failed = useCallback(
    (e: unknown): string => {
      const { message, sheet } = writeFailure(e)
      if (sheet !== null) {
        openTopUp(sheet)
        void refreshBalance().catch(() => undefined)
      }
      return message
    },
    [openTopUp, refreshBalance],
  )

  const disabledReason = funds?.level === 'empty' ? EMPTY_REASON[funds.reason ?? 'balance'] : null
  return { check, failed, disabledReason }
}
