/**
 * Cost preview — signature element (style guide §A.2, `ux-dx-spec.md` §4 rule 1). Every
 * signing button shows its price before the click: DASH primary, USD secondary, plus any v1
 * WRITE/MAINTAIN token spend. A delete that returns storage shows the refund in green.
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
  /** Render as a refund (green, credited back). Implied by a negative estimate. */
  refund?: boolean
  className?: string
}): JSX.Element {
  const isRefund = refund || cost.credits < 0
  const dash = Math.abs(cost.dash)
  const token =
    cost.tokenAmount > 0 && cost.tokenPosition !== undefined ? TOKEN_LABEL[cost.tokenPosition] : undefined
  return (
    <div
      data-testid="cost-preview"
      title="Estimated from measured Platform fees; the actual charge is recorded in Settings → Spend."
      className={cn(
        'flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border px-2.5 py-1.5 text-dense',
        isRefund ? 'border-verify/30 bg-verify/5' : 'border-anvil-200 bg-anvil-50 dark:border-anvil-750 dark:bg-anvil-850',
        className,
      )}
    >
      <span className="text-anvil-500 dark:text-anvil-400">{isRefund ? 'Refund est.' : 'Cost'}</span>
      <span className={cn('font-mono font-medium', isRefund ? 'text-verify' : 'text-dash-600 dark:text-dash-400')}>
        {isRefund ? '+' : '~'}
        {formatDash(dash)} DASH
      </span>
      <span className="font-mono text-anvil-500 dark:text-anvil-400">≈ {dashToUsd(dash)}</span>
      {token ? (
        <span className="ml-auto inline-flex items-center gap-1 rounded bg-forge-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-forge-600 dark:text-forge-400">
          + {cost.tokenAmount} {token} token
        </span>
      ) : null}
    </div>
  )
}
