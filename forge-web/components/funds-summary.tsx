'use client'

/**
 * This browser's key, in words (QW-048): what is left of its budget and when it expires. The funds
 * pill only has room for a 2 px bar and a hover title, which a phone never shows, so the account
 * menu and the top-up sheet carry this line. Nothing for a key without limits (a pasted key or a
 * wallet's), which has neither.
 */

import { KeyRound } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { creditsAsDash, formatDate } from '@/lib/view/format'
import { cn } from '@/lib/utils'

export function KeyFundsLine({ className }: { className?: string }): JSX.Element | null {
  const { keyLimits, funds, balance } = useAuth()
  if (keyLimits === null || (keyLimits.total === null && keyLimits.expiresAt === null)) return null
  const warn = funds?.reason === 'key-budget' || funds?.reason === 'key-expiry'
  // A budget above the balance is not all spendable (QW2-035: "0.05 of 0.05 DASH left" beside a
  // 0.0054 DASH balance): say the balance caps it.
  const capped = balance !== null && keyLimits.remaining !== null && BigInt(balance) < keyLimits.remaining
  const parts = [
    keyLimits.remaining !== null && keyLimits.total !== null ? `${creditsAsDash(Number(keyLimits.remaining))} of ${creditsAsDash(Number(keyLimits.total))} DASH budget left` : null,
    capped ? `capped by your ${creditsAsDash(Number(balance))} DASH balance` : null,
    keyLimits.expiresAt !== null ? `expires ${formatDate(keyLimits.expiresAt)}` : null,
  ].filter((p): p is string => p !== null)
  return (
    <p
      data-testid="key-funds-line"
      className={cn('flex items-start gap-1.5 text-[12px]', warn ? 'text-caution-700 dark:text-caution-400' : 'text-anvil-500 dark:text-anvil-400', className)}
    >
      <KeyRound className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      <span>This browser&apos;s key: {parts.join(', ')}</span>
    </p>
  )
}
