/**
 * Cost preview — signature element (style guide §A.2, `ux-dx-spec.md` §4 rule 1). Every
 * signing button shows its price before the click: DASH primary, fiat secondary. A delete that
 * returns storage shows the refund in green.
 */

import type { CostPreview as Cost } from '@/lib/sdk'
import { formatDash } from '@/lib/view/format'
import { FiatNote } from './fiat-note'
import { creditsToDash } from '@/lib/sdk/cost'
import { creditsAsDash } from '@/lib/view/format'
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
  return (
    <div
      data-testid="cost-preview"
      title={
        isRefund
          ? 'Approximate refund if deleted soon after creation; less as it ages, possibly zero. The actual amount is recorded in Settings → Spend.'
          : 'Estimated from measured Platform fees; the actual charge is recorded in Settings → Spend.'
      }
      className={cn(
        'flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border px-2.5 py-1.5 text-dense',
        isRefund ? 'border-verify/30 bg-verify/5' : 'border-anvil-200 bg-anvil-50 dark:border-anvil-750 dark:bg-anvil-850',
        className,
      )}
    >
      <span className="text-anvil-500 dark:text-anvil-400">{isRefund ? 'Refund about' : 'Cost'}</span>
      <span className={cn('font-mono font-medium', isRefund ? 'text-verify-700 dark:text-verify-400' : 'text-dash-600 dark:text-dash-400')}>
        {isRefund ? '+' : min !== null ? '' : '~'}
        {min !== null ? `${creditsAsDash(min)}–` : ''}
        {formatDash(dash)} DASH
      </span>
      {isRefund ? <span className="text-anvil-500 dark:text-anvil-400">if deleted soon; less as it ages</span> : null}
      <FiatNote dash={dash} range={min !== null ? creditsToDash(min) : undefined} variant="bare" />
    </div>
  )
}
