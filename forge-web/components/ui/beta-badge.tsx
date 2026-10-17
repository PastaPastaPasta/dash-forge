'use client'

/**
 * A small "Beta" pill for a feature that works but has rough edges (MIXE-09). Which features wear
 * it is `lib/beta.ts`'s one list: a feature that is not in it renders nothing, so graduating a
 * feature means deleting its entry. The tooltip says what beta means and the pill links to the
 * guide's "Known limitations".
 */

import { BETA_FEATURES, BETA_TOOLTIP, isBeta, type BetaFeature } from '@/lib/beta'
import { DOCS } from '@/lib/docs-links'
import { cn } from '@/lib/utils'

export function BetaBadge({ feature, className }: { feature: BetaFeature; className?: string }): JSX.Element | null {
  if (!isBeta(feature)) return null
  return (
    <a
      href={DOCS.knownLimitations}
      target="_blank"
      rel="noreferrer noopener"
      title={BETA_TOOLTIP}
      aria-label={`${BETA_FEATURES[feature]} is in beta. ${BETA_TOOLTIP}`}
      data-testid="beta-badge"
      data-feature={feature}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border border-caution/40 bg-caution/5 px-1.5 py-px align-middle text-[10px] font-medium normal-case leading-snug tracking-normal text-caution-700 hover:bg-caution/10 dark:text-caution-400',
        className,
      )}
    >
      Beta
    </a>
  )
}
