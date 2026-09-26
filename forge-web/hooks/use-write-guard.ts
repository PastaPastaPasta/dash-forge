'use client'

/**
 * useWriteGuard — the checks every signing button runs before it signs (`ux-dx-spec.md` §4):
 * signed out opens the sign-in sheet; an empty balance, a spent or expired key, or a write
 * that does not fit either budget opens the top-up sheet with the shortfall. Returns whether
 * the write may proceed, plus a disabled-reason for buttons in the empty state.
 */

import { useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { affordability } from '@/lib/view/funds'

export interface WriteGuard {
  /** Run before signing: true when the write may go ahead (else a sheet opened). */
  readonly check: (estimateCredits: number) => boolean
  /** Why every write button is disabled (empty state), or null. */
  readonly disabledReason: string | null
}

const EMPTY_REASON: Readonly<Record<'balance' | 'key-budget' | 'key-expiry', string>> = {
  balance: 'Balance is 0 — reading still works.',
  'key-budget': "This browser's key budget is spent — reading still works.",
  'key-expiry': "This browser's key has expired — reading still works.",
}

export function useWriteGuard(): WriteGuard {
  const { identity, signer, balance, funds, keyLimits } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const openTopUp = useUiStore((s) => s.openTopUp)

  const check = useCallback(
    (estimateCredits: number): boolean => {
      if (!identity || !signer) {
        openLogin()
        return false
      }
      if (funds?.level === 'empty') {
        openTopUp({ blocker: funds.reason ?? 'balance' })
        return false
      }
      const a = affordability(estimateCredits, BigInt(balance ?? '0'), keyLimits)
      if (!a.ok) {
        openTopUp({ blocker: a.blocker, shortfall: a.shortfall })
        return false
      }
      return true
    },
    [balance, funds, identity, keyLimits, openLogin, openTopUp, signer],
  )

  const disabledReason = funds?.level === 'empty' ? EMPTY_REASON[funds.reason ?? 'balance'] : null
  return { check, disabledReason }
}
