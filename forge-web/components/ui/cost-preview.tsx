/**
 * Cost preview — signature element (style guide §A.2). Every cost-bearing action shows its
 * price BEFORE signing: DASH primary, USD secondary, plus any WRITE/MAINTAIN token spend.
 * Destructive refunds render in verify-green. Free actions render nothing.
 */

import type { CostPreview as Cost } from '@/lib/sdk'
import { dashToUsd, formatDash } from '@/lib/view'
import { cn } from '@/lib/utils'

const TOKEN_LABEL: Readonly<Record<number, string>> = { 0: 'WRITE', 1: 'MAINTAIN' }

export function CostPreview({
  cost,
  refund = false,
  className,
}: {
  cost: Cost
  /** Render as a refund estimate (green, credited back). */
  refund?: boolean
  className?: string
}): JSX.Element {
  const token =
    cost.tokenAmount > 0 && cost.tokenPosition !== undefined
      ? TOKEN_LABEL[cost.tokenPosition]
      : undefined
  return (
    <div
      className={cn(
        'flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border px-2.5 py-1.5 text-dense',
        refund
          ? 'border-verify/30 bg-verify/5'
          : 'border-anvil-200 bg-anvil-50 dark:border-anvil-750 dark:bg-anvil-850',
        className,
      )}
    >
      <span className="text-anvil-500 dark:text-anvil-400">{refund ? 'Refund est.' : 'Cost'}</span>
      <span className={cn('font-mono font-medium', refund ? 'text-verify' : 'text-dash')}>
        {refund ? '+' : '~'}
        {formatDash(cost.dash)} DASH
      </span>
      <span className="font-mono text-anvil-400 dark:text-anvil-500">≈ {dashToUsd(cost.dash)}</span>
      {token ? (
        <span className="ml-auto inline-flex items-center gap-1 rounded bg-forge-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-forge-600 dark:text-forge-400">
          + {cost.tokenAmount} {token} token
        </span>
      ) : null}
    </div>
  )
}
