/**
 * Cost preview — signature element (style guide §A.2, `ux-dx-spec.md` §4 rule 1). Every
 * signing button shows its price before the click: DASH primary, USD secondary. A delete that
 * returns storage shows the refund in green.
 */

import type { CostPreview as Cost } from '@/lib/sdk'
import { dashToUsd, formatDash } from '@/lib/view'
import { creditsAsDash } from '@/lib/view/format'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { cn } from '@/lib/utils'

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
  // An edit's charge ranges far below its bound: show the range Settings → Spend records (QW3-037).
  const min = !isRefund && cost.minCredits !== undefined && cost.minCredits < cost.credits ? cost.minCredits : null
  const usd = dashToUsd(dash, ACTIVE_NETWORK.network)
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
      <span className={cn('font-mono font-medium', isRefund ? 'text-verify-700 dark:text-verify-400' : 'text-dash-600 dark:text-dash-400')}>
        {isRefund ? '+' : min !== null ? '' : '~'}
        {min !== null ? `${creditsAsDash(min)}–` : ''}
        {formatDash(dash)} DASH
      </span>
      {usd !== null ? <span className="font-mono text-anvil-500 dark:text-anvil-400">≈ {usd}</span> : null}
    </div>
  )
}
