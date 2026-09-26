'use client'

/**
 * Funds pill (`ux-dx-spec.md` §2.3, §4): the balance, coloured by state — normal when
 * comfortable, amber when low (balance < 0.01 DASH, or this key < 20 % / < 7 days), red when
 * empty — with the one fix a click opens: the top-up sheet. A limited key adds a thin budget
 * bar and its expiry in the tooltip.
 */

import { Wallet } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { balanceToDash, creditsAsDash, formatDate } from '@/lib/view/format'
import { cn } from '@/lib/utils'

export function FundsPill(): JSX.Element | null {
  const { balance, funds, keyLimits } = useAuth()
  const openTopUp = useUiStore((s) => s.openTopUp)
  if (balance === null || funds === null) return null
  const level = funds.level
  const budget =
    keyLimits?.total != null && keyLimits.total > 0n && keyLimits.remaining !== null
      ? Math.max(0, Math.min(1, Number(keyLimits.remaining) / Number(keyLimits.total)))
      : null
  const tooltip = [
    `Balance ${balanceToDash(balance)} DASH`,
    keyLimits?.remaining != null && keyLimits.total != null
      ? `This browser's key: ${creditsAsDash(Number(keyLimits.remaining))} of ${creditsAsDash(Number(keyLimits.total))} DASH left`
      : null,
    keyLimits?.expiresAt != null ? `expires ${formatDate(keyLimits.expiresAt)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <button
      type="button"
      data-testid="funds-pill"
      data-level={level}
      title={tooltip}
      aria-label={`${tooltip}${level === 'comfortable' ? '' : ` — ${level}, click to fix`}`}
      onClick={() => {
        if (level !== 'comfortable') {
          openTopUp({ blocker: funds.reason === 'balance' || funds.reason === null ? 'balance' : funds.reason })
        }
      }}
      className={cn(
        'hidden flex-col items-stretch rounded-full border px-2.5 py-0.5 text-[12px] sm:flex',
        level === 'empty'
          ? 'border-danger/50 bg-danger/10 text-danger'
          : level === 'low'
            ? 'border-caution/50 bg-caution/10 text-caution'
            : 'border-anvil-200 text-anvil-600 dark:border-anvil-750 dark:text-anvil-300',
      )}
    >
      <span className="inline-flex items-center gap-1 font-mono">
        <Wallet className="h-3 w-3" aria-hidden />
        {balanceToDash(balance)} DASH
      </span>
      {budget !== null ? (
        <span className="mt-0.5 h-0.5 w-full overflow-hidden rounded bg-anvil-200 dark:bg-anvil-800" aria-hidden>
          <span className={cn('block h-full', level === 'comfortable' ? 'bg-dash-500' : 'bg-current')} style={{ width: `${budget * 100}%` }} />
        </span>
      ) : null}
    </button>
  )
}
